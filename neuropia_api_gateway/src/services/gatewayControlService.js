// services/gatewayControlService.js
const RedisService = require("@shared/clients/redis_op");
const { eventBus } = require("../listeners/pgNotifyListener");
const ALL_CHANNELS = require("../constants/pgNotifyChannels");
const logger = require("@shared/utils/logger");
const CACHE_KEYS = require("../constants/cacheKeys");
const balanceService = require("./balanceService");

class GatewayControlService {
  constructor() {
    this.config = null; // 内存中的配置树
    this.cacheKey = "gateway:config:payload:v1";
    this.alertCooldown = new Map(); // 软告警冷却
  }

  // ==================== 初始化 ====================

  async initialize() {
    logger.info("[GATEWAY_CONFIG] 初始化配置服务");

    // 1. 从Redis加载配置
    await this.loadConfigFromCache();

    // 2. 监听配置更新
    eventBus.on(ALL_CHANNELS.GATEWAY_CONTROL_CHANGES, (payload) => {
      this.handleConfigUpdate(payload);
    });

    logger.info("[GATEWAY_CONFIG] 服务初始化完成");
  }

  async loadConfigFromCache() {
    try {
      const cached = await RedisService.kv.get(this.cacheKey);
      if (cached) {
        this.config = JSON.parse(cached);
        logger.info("[GATEWAY_CONFIG] 从缓存加载配置成功");
      } else {
        logger.warn("[GATEWAY_CONFIG] 缓存中没有配置，使用备用配置");
        this.config = this.getFallbackConfig();
      }
    } catch (error) {
      logger.error("[GATEWAY_CONFIG] 加载配置失败", error);
      this.config = this.getFallbackConfig();
    }
  }

  // ==================== 配置获取 ====================

  /**
   * 获取用户完整配置
   */
  getConfig(user, provider = null, model = null) {
    if (!this.config) {
      return this.getFallbackConfig();
    }

    const result = {};
    this.mergeConfig(result, this.config.global);

    // 1. 客户类型配置
    if (user.customer_type && this.config.customer_types[user.customer_type]) {
      this.mergeConfig(result, this.config.customer_types[user.customer_type]);
    }

    // 2. 租户配置
    if (user.tenant_id && this.config.tenants[user.tenant_id]) {
      const tenant = this.config.tenants[user.tenant_id];

      // 租户全局
      this.mergeConfig(result, tenant.global);

      // 供应商级别
      if (provider && tenant.providers && tenant.providers[provider]) {
        const providerConfig = tenant.providers[provider];
        this.mergeConfig(result, providerConfig.global);

        // 模型级别
        if (model && providerConfig.models && providerConfig.models[model]) {
          this.mergeConfig(result, providerConfig.models[model]);
        }
      }
    }

    return result;
  }

  /**
   * 合并配置（后覆盖前）
   */
  mergeConfig(target, source) {
    if (!source) return;

    for (const [key, value] of Object.entries(source)) {
      if (value !== null && value !== undefined) {
        target[key] = value;
      }
    }
  }

  // ==================== 余额检查 ====================

  /**
   * 检查余额是否允许请求
   * @param {Object} user - 用户信息
   * @param {Function} getBalanceFunc - 获取余额的函数
   * @param {number} estimatedCost - 预估费用
   * @returns {Object} { allowed: boolean, reason?: string, balance: number }
   */
  async checkBalance(user, estimatedCost = 0) {
    try {
      const config = this.getConfig(user);
      const balance = await balanceService.getBalanceForUser(user);

      // 1. 硬限制检查
      if (config.hard_limit && balance <= config.hard_limit.value) {
        logger.warn("[BALANCE_CHECK] 硬限制触发", {
          user,
          balance,
          hard_limit: config.hard_limit.value,
        });
        return {
          allowed: false,
          reason: "HARD_LIMIT_EXCEEDED",
          balance,
          limit_type: "hard",
          limit_value: config.hard_limit.value,
        };
      }

      // 2. 软限制检查（告警）
      if (config.soft_limit && balance <= config.soft_limit.value) {
        await this.handleSoftLimit(user, balance, config.soft_limit.value);
      }

      // 3. 余额是否足够支付
      if (estimatedCost > 0 && balance < estimatedCost) {
        logger.warn("[BALANCE_CHECK] 余额不足", {
          user,
          balance,
          estimatedCost,
        });
        return {
          allowed: false,
          reason: "INSUFFICIENT_BALANCE",
          balance,
          required: estimatedCost,
        };
      }

      return { allowed: true, balance };
    } catch (error) {
      logger.error("[BALANCE_CHECK] 余额检查失败", {
        error: error.message,
        stack: error.stack,
        user,
      });
      // 检查失败时，默认允许（安全起见）
      return { allowed: true, balance: 0, error: error.message };
    }
  }

  /**
   * 处理软限制告警（避免重复告警）
   */
  async handleSoftLimit(user, balance, softLimit) {
    const alertKey = CACHE_KEYS.UTILS.buildAlertCooldownKey(
      user.tenant_id,
      user.customer_type,
    );

    // 使用工具方法检查冷却
    const shouldAlert = await CACHE_KEYS.UTILS.checkAndSetAlertCooldown(
      alertKey,
      CACHE_KEYS.TTL.SOFT_LIMIT_ALERT,
    );

    if (shouldAlert) {
      logger.warn("[SOFT_LIMIT_ALERT] 余额软限制告警", {
        user,
        balance,
        soft_limit: softLimit,
      });
      // 发送告警...
    }
  }

  // ==================== 限流检查 ====================

  /**
   * 检查TPM限制
   * @returns {Object} { allowed: boolean, remaining: number, reset: number }
   */
  async checkTPM(user, provider = null, model = null, tokens = 1) {
    return this.checkRateLimit("tpm", user, provider, model, tokens);
  }

  /**
   * 检查RPM限制
   */
  async checkRPM(user, provider = null, tokens = 1) {
    return this.checkRateLimit("rpm", user, provider, null, tokens);
  }

  /**
   * 通用限流检查
   */
  async checkRateLimit(type, user, provider, model, tokens = 1) {
    try {
      const config = this.getConfig(user, provider, model);
      const limitConfig = config[type];

      if (!limitConfig) {
        // 无限制
        return { allowed: true, remaining: Infinity, reset: 0 };
      }

      const { value: limit, time_window: window } = limitConfig;
      const key = this.buildRateLimitKey(type, user, provider, model, window);

      // 使用Lua脚本保证原子性
      const luaScript = `
        local key = KEYS[1]
        local limit = tonumber(ARGV[1])
        local tokens = tonumber(ARGV[2])
        local window = tonumber(ARGV[3])

        local current = redis.call('GET', key)
        if current then
          current = tonumber(current)
          if current + tokens > limit then
            return {0, current, limit - current}
          end
        end

        local newVal = redis.call('INCRBY', key, tokens)
        if newVal == tokens then
          redis.call('EXPIRE', key, window)
        end

        return {1, newVal, limit - newVal}
      `;

      const result = await RedisService.kv.eval(
        luaScript,
        1,
        key,
        limit,
        tokens,
        window,
      );

      const [allowed, current, remaining] = result;
      const resetTime =
        Math.floor(Date.now() / 1000 / window) * window + window;

      return {
        allowed: allowed === 1,
        current: Number(current),
        remaining: Number(remaining),
        limit: limit,
        reset: resetTime,
      };
    } catch (error) {
      logger.error(`[RATE_LIMIT_${type.toUpperCase()}] 检查失败`, {
        error: error.message,
        user,
        provider,
        model,
      });
      // 限流检查失败时，默认允许
      return {
        allowed: true,
        remaining: Infinity,
        reset: 0,
        error: error.message,
      };
    }
  }

  /**
   * 构建限流键
   */
  buildRateLimitKey(type, user, provider, model, window) {
    const windowStart = Math.floor(Date.now() / 1000 / window) * window;

    if (user.tenant_id) {
      // 租户限流
      let parts = ["rate", type, user.tenant_id];
      if (provider) parts.push(provider);
      if (model && type === "tpm") parts.push(model); // RPM没有模型级别
      parts.push(windowStart);
      return parts.join(":");
    } else {
      // 个人用户限流
      return `rate:${type}:user:${user.id}:${windowStart}`;
    }
  }

  /**
   * 获取当前限流状态（用于监控）
   */
  async getRateLimitStatus(type, user, provider, model) {
    const config = this.getConfig(user, provider, model);
    const limitConfig = config[type];

    if (!limitConfig) {
      return { enabled: false };
    }

    const { value: limit, time_window: window } = limitConfig;
    const key = this.buildRateLimitKey(type, user, provider, model, window);
    const current = (await RedisService.kv.get(key)) || 0;

    return {
      enabled: true,
      current: Number(current),
      limit: limit,
      remaining: limit - Number(current),
      window: window,
      utilization: ((Number(current) / limit) * 100).toFixed(1) + "%",
    };
  }

  // ==================== 配置更新 ====================

  async handleConfigUpdate(payload) {
    try {
      logger.info("[GATEWAY_CONFIG] 收到配置更新通知");

      const newConfig =
        typeof payload === "string" ? JSON.parse(payload) : payload;

      // 验证配置结构
      if (!this.validateConfig(newConfig)) {
        logger.error("[GATEWAY_CONFIG] 无效的配置格式");
        return;
      }

      // 更新内存配置
      this.config = newConfig;

      // 更新Redis缓存
      await RedisService.kv.set(this.cacheKey, JSON.stringify(newConfig), 0);

      logger.info("[GATEWAY_CONFIG] 配置更新成功");

      // 清理告警冷却
      this.alertCooldown.clear();
    } catch (error) {
      logger.error("[GATEWAY_CONFIG] 更新配置失败", error);
    }
  }

  validateConfig(config) {
    return (
      config &&
      typeof config === "object" &&
      "global" in config &&
      "tenants" in config &&
      "customer_types" in config &&
      "metadata" in config
    );
  }

  // ==================== 工具方法 ====================

  getFallbackConfig() {
    return {
      global: {
        soft_limit: { value: 100, time_window: null },
        hard_limit: { value: 0, time_window: null },
        tpm: { value: 10000, time_window: 60 },
        rpm: { value: 60, time_window: 60 },
      },
      customer_types: {},
      tenants: {},
      metadata: { generated_at: new Date().toISOString(), config_count: 0 },
    };
  }

  /**
   * 获取当前配置快照（用于调试）
   */
  getConfigSnapshot() {
    return {
      has_config: !!this.config,
      metadata: this.config?.metadata,
      cache_key: this.cacheKey,
      alert_cooldown_size: this.alertCooldown.size,
    };
  }
}

module.exports = new GatewayControlService();
