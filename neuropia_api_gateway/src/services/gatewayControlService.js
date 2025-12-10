// services/gatewayControlService.js
const RedisService = require("@shared/clients/redis_op");
const { eventBus } = require("../listeners/pgNotifyListener");
const ALL_CHANNELS = require("../constants/pgNotifyChannels");
const logger = require("@shared/utils/logger");
const CACHE_KEYS = require("../constants/cacheKeys"); // ✅ 新增：引入常量
const pg = require("@shared/clients/pg");

class GatewayControlService {
  constructor() {
    this.defaultLimits = {
      soft_limit: 10, // 默认软限额 $10
      hard_limit: 10, // 当前硬编码值
    };
  }

  /**
   * 获取账户限额配置
   * @param {Object} params - 账户信息
   * @param {string} params.account_type - 'user' 或 'tenant'
   * @param {string} params.account_id - 账户ID
   * @param {string} params.customer_type_id - 客户类型ID
   * @returns {Promise<{soft_limit: number, hard_limit: number}>}
   */
  async getLimits(params) {
    const { account_type, account_id, customer_type_id } = params;

    logger.debug("[GATEWAY_CONTROL] 查询限额", {
      account_type,
      account_id,
      customer_type_id,
      timestamp: new Date().toISOString(),
    });

    // ✅ 分别构建 soft_limit 和 hard_limit 的缓存键
    const softKey = this._buildLimitCacheKey(
      account_type,
      account_id,
      customer_type_id,
      "soft_limit",
    );
    const hardKey = this._buildLimitCacheKey(
      account_type,
      account_id,
      customer_type_id,
      "hard_limit",
    );

    // ✅ 并行查询两个缓存
    const [softCached, hardCached] = await Promise.all([
      RedisService.kv.get(softKey),
      RedisService.kv.get(hardKey),
    ]);

    // ✅ 如果都有缓存，直接返回
    if (softCached !== null && hardCached !== null) {
      logger.debug("[GATEWAY_CONTROL] 缓存命中", {
        softKey,
        hardKey,
        soft_value: softCached,
        hard_value: hardCached,
      });

      return {
        soft_limit: Number(softCached),
        hard_limit: Number(hardCached),
      };
    }

    logger.debug("[GATEWAY_CONTROL] 缓存未命中，查询数据库", {
      softKey,
      hardKey,
      query_params: { account_type, account_id, customer_type_id },
    });

    // ✅ 查询数据库并缓存结果
    const limits = await this._queryAndCacheLimits(
      account_type,
      account_id,
      customer_type_id,
      softKey,
      hardKey,
    );

    return limits;
  }

  /**
   * 构建限额缓存键（使用CACHE_KEYS常量）
   */
  _buildLimitCacheKey(
    account_type,
    account_id,
    customer_type_id,
    control_type,
  ) {
    // ✅ 严格使用 CACHE_KEYS.GATEWAY_CONTROL 常量
    if (account_type === "tenant") {
      // 租户配置：基础限额（不分供应商/模型）
      return CACHE_KEYS.GATEWAY_CONTROL.TENANT_BASE(account_id, control_type);
    } else if (customer_type_id) {
      // 客户类型配置
      return CACHE_KEYS.GATEWAY_CONTROL.CUSTOMER_TYPE(
        customer_type_id,
        control_type,
      );
    } else {
      // 全局配置
      return CACHE_KEYS.GATEWAY_CONTROL.GLOBAL(control_type);
    }
  }

  /**
   * 查询数据库并缓存结果
   */
  async _queryAndCacheLimits(
    account_type,
    account_id,
    customer_type_id,
    softKey,
    hardKey,
  ) {
    const query = `SELECT * FROM api.get_gateway_limits($1, $2)`;

    try {
      const result = await pg.query(query, [
        account_type === "tenant" ? account_id : null,
        customer_type_id,
      ]);

      let limits;

      // ✅ 核心规则：hard_limit必须存在！
      if (result.rows[0]?.hard_limit !== null) {
        limits = {
          soft_limit: Number(
            result.rows[0]?.soft_limit || this.defaultLimits.soft_limit,
          ),
          hard_limit: Number(result.rows[0].hard_limit),
        };
        logger.debug("[GATEWAY_CONTROL] 查询到有效配置", limits);
      } else {
        // ❌ 严重错误：缺少hard_limit！
        logger.error("[GATEWAY_CONTROL] ❌ 缺少hard_limit配置，使用最严格限制");
        limits = {
          soft_limit: this.defaultLimits.soft_limit,
          hard_limit: 0, // 完全禁止
        };
      }

      // ✅ 异步缓存（不阻塞返回）
      try {
        await Promise.all([
          RedisService.kv.set(softKey, limits.soft_limit.toString()),
          RedisService.kv.set(hardKey, limits.hard_limit.toString()),
        ]);
        logger.debug("[GATEWAY_CONTROL] 缓存写入成功", { softKey, hardKey });
      } catch (cacheError) {
        logger.warn("[GATEWAY_CONTROL] 缓存写入失败", {
          error: cacheError.message,
          keys: [softKey, hardKey],
        });
      }

      return limits;
    } catch (error) {
      logger.error("[GATEWAY_CONTROL] 查询限额配置失败", {
        error: error.message,
        account_type,
        account_id,
      });
      // 返回最安全的默认值
      return {
        soft_limit: this.defaultLimits.soft_limit,
        hard_limit: 0, // 查询失败时完全禁止
      };
    }
  }

  /**
   * 监听配置变更，清理缓存
   */
  async initialize() {
    // 移除重复注册（这里好像有重复）
    eventBus.on(ALL_CHANNELS.GATEWAY_CONTROL_CHANGES, (payload) => {
      this._handleConfigChange(payload);
    });

    logger.info(
      "[GATEWAY_CONTROL] 服务初始化完成，监听频道:",
      ALL_CHANNELS.GATEWAY_CONTROL_CHANGES,
    );
  }

  _handleConfigChange(payload) {
    const { operation, record } = payload;
    const { target_type, target_id, control_type } = record;

    logger.debug("[GATEWAY_CONTROL] 收到配置变更通知", {
      operation,
      target_type,
      target_id: target_id || "global",
      control_type,
      control_value: record.control_value,
      timestamp: new Date().toISOString(),
    });

    // ✅ 只清理余额限额相关的缓存（soft_limit 和 hard_limit）
    if (control_type === "soft_limit" || control_type === "hard_limit") {
      this._cleanLimitCaches(target_type, target_id);
    }

    // ✅ 如果是 TPM/RPM 变更，清理对应的缓存（这里可以留作后续扩展）
    // if (control_type === 'tpm' || control_type === 'rpm') {
    //   this._cleanRateLimitCaches(record);
    // }
  }

  /**
   * 清理余额限额相关的缓存
   */
  async _cleanLimitCaches(target_type, target_id) {
    const cacheKeys = [];

    // ✅ 根据 CACHE_KEYS 规范构建要清理的键
    if (target_type === "tenant") {
      cacheKeys.push(
        CACHE_KEYS.GATEWAY_CONTROL.TENANT_BASE(target_id, "soft_limit"),
        CACHE_KEYS.GATEWAY_CONTROL.TENANT_BASE(target_id, "hard_limit"),
      );
    } else if (target_type === "customer_type") {
      cacheKeys.push(
        CACHE_KEYS.GATEWAY_CONTROL.CUSTOMER_TYPE(target_id, "soft_limit"),
        CACHE_KEYS.GATEWAY_CONTROL.CUSTOMER_TYPE(target_id, "hard_limit"),
      );
    } else if (target_type === "global") {
      cacheKeys.push(
        CACHE_KEYS.GATEWAY_CONTROL.GLOBAL("soft_limit"),
        CACHE_KEYS.GATEWAY_CONTROL.GLOBAL("hard_limit"),
      );
    }

    if (cacheKeys.length > 0) {
      // ✅ 批量删除缓存
      const deletePromises = cacheKeys.map((key) => RedisService.kv.del(key));
      const results = await Promise.all(deletePromises);

      const deletedCount = results.reduce((sum, count) => sum + count, 0);

      logger.debug("[GATEWAY_CONTROL] 清理限额缓存完成", {
        cacheKeys,
        deletedCount,
        reason: "配置变更通知",
      });
    }
  }
}

module.exports = new GatewayControlService();
