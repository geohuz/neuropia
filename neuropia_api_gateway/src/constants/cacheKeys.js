// constants/cacheKeys.js
const crypto = require("crypto");

const CACHE_KEYS = {
  // 虚拟 key 的最终配置
  VIRTUAL_KEY_CONFIG: (virtualKey) => `vk_config:${virtualKey}`,

  // 节点到虚拟 key 的映射
  NODE_VK_MAPPING: (nodeId) => `node_vk_mapping:${nodeId}`,

  // pricing
  VIRTUAL_KEY_PRICING: (vk) => `vk:${vk}:pricing`,
  CUSTOMER_TYPE_PRICING: (ctId) => `price:ct:${ctId}`,

  // billing 主体缓存（vk -> billing account）
  BILLING_ACCOUNT: (vk) => `billing_account:${vk}`,

  // 账户余额缓存（按 type + id）
  BALANCE: (type, id) => `balance:${type}:${id}`,

  // 统一计费上下文缓存（核心）
  BILLING_CONTEXT: (vk) => `billing:ctx:${vk}`,

  // 虚拟键到客户类型映射（快速校验用）
  VIRTUAL_KEY_TO_CT: (vk) => `vk:${vk}:ct`,

  // 价格查找缓存（避免每次遍历prices对象）
  PRICE_LOOKUP: (vk, provider, model) => `price:${vk}:${provider}:${model}`,

  // 批量余额查询（可选，用于dashboard等）
  BULK_BALANCE_PREFIX: "bulk:balance:",

  // 审计日志缓存（保存扣费记录）
  CHARGE_AUDIT: (traceId) => `audit:charge:${traceId}`,

  // 缓存统计（监控用）
  CACHE_STATS: {
    HIT_RATE: "stats:cache:hit_rate",
    LATENCY: "stats:cache:latency",
    INVALIDATION_COUNT: "stats:cache:invalidation_count",
  },

  // ==================== 网关控制配置 ====================
  // Gateway 配置整体缓存（新设计）
  GATEWAY_CONFIG: {
    // 整体配置payload
    FULL_PAYLOAD: "gateway:config:full_payload:v1",

    // 备用配置（当主配置失效时）
    FALLBACK_CONFIG: "gateway:config:fallback",

    // 配置版本号（用于验证）
    VERSION: "gateway:config:version",
  },

  // Gateway 限流计数器（保持原样，因为需要时间窗口）
  GATEWAY_RATE_LIMIT: {
    // TPM 计数器
    TPM: (tenant_id, provider_name, model_name, window_start) => {
      let key = `gateway:ratelimit:tpm`;
      if (tenant_id) key += `:${tenant_id}`;
      else key += ":user";
      if (provider_name) key += `:${provider_name}`;
      if (model_name) key += `:${model_name}`;
      return `${key}:${window_start}`;
    },

    // RPM 计数器
    RPM: (tenant_id, provider_name, window_start) => {
      let key = `gateway:ratelimit:rpm`;
      if (tenant_id) key += `:${tenant_id}`;
      else key += ":user";
      if (provider_name) key += `:${provider_name}`;
      return `${key}:${window_start}`;
    },

    // 个人用户 TPM/RPM 计数器（兼容旧版）
    USER: (user_id, control_type, window_start) =>
      `gateway:ratelimit:${control_type}:user:${user_id}:${window_start}`,
  },

  // 告警冷却缓存（避免重复告警）
  GATEWAY_ALERTS: {
    SOFT_LIMIT_ALERT: (tenant_id, customer_type) =>
      `gateway:alert:soft_limit:${tenant_id || "global"}:${customer_type || "default"}`,
  },
};

// TTL 配置
CACHE_KEYS.TTL = {
  BILLING_CONTEXT: 1800, // 30分钟（主要受余额影响）
  BALANCE: 60, // 1分钟
  BILLING_ACCOUNT: 3600, // 1小时
  VIRTUAL_KEY_PRICING: 2592000, // 30天（价格变动靠notify失效）
  CUSTOMER_TYPE_PRICING: 2592000, // 30天
  VIRTUAL_KEY_CONFIG: 86400, // 24小时
  PRICE_LOOKUP: 2592000, // 30天
  CHARGE_AUDIT: 604800, // 7天
  VIRTUAL_KEY_TO_CT: 2592000, // 30天

  // 网关控制配置TTL - 整体payload永不过期（靠notify失效）
  GATEWAY_CONFIG_FULL: 0, // 0表示永不过期

  // 限流计数器TTL - 自动过期
  RATE_LIMIT_TPM: 120, // 2分钟（比60秒长，确保时间窗口覆盖）
  RATE_LIMIT_RPM: 120,
  RATE_LIMIT_USER: 120,

  // 告警冷却TTL（避免重复告警）
  SOFT_LIMIT_ALERT: 300, // 5分钟内不重复告警
};

// 缓存键工具方法
CACHE_KEYS.UTILS = {
  // 生成批量余额查询的键
  bulkBalanceKey: (accountType, accountIds) => {
    const sortedIds = [...accountIds].sort();
    const hash = crypto
      .createHash("md5")
      .update(sortedIds.join(","))
      .digest("hex")
      .substring(0, 8);
    return `bulk:balance:${accountType}:${hash}`;
  },

  // 检查是否为某个前缀的键（用于批量删除）
  isBillingContextKey: (key) => key.startsWith("billing:ctx:"),
  isBalanceKey: (key) => key.startsWith("balance:"),
  isPricingKey: (key) => key.startsWith("vk:") && key.includes(":pricing"),

  // 从缓存键提取信息
  extractVirtualKeyFromContext: (key) => key.replace("billing:ctx:", ""),
  extractAccountFromBalance: (key) => {
    const parts = key.split(":");
    return { type: parts[1], id: parts[2] };
  },

  // Gateway 相关工具（简化版）
  isGatewayConfigKey: (key) => key.startsWith("gateway:config:"),
  isRateLimitKey: (key) => key.startsWith("gateway:ratelimit:"),

  // 从限流计数器键提取信息（简化版）
  extractFromRateLimitKey: (key) => {
    // gateway:ratelimit:{type}[:{tenant_id}][:{provider_name}][:{model_name}]:{window_start}
    const parts = key.split(":");
    if (parts.length < 3) return null;

    const result = {
      type: parts[2], // tpm 或 rpm
      window_start: parseInt(parts[parts.length - 1]),
    };

    if (parts[3] && parts[3] !== "user") {
      result.tenant_id = parts[3];
      if (parts[4] && !parts[4].match(/^\d+$/)) {
        result.provider_name = parts[4];
        if (parts[5] && !parts[5].match(/^\d+$/)) {
          result.model_name = parts[5];
        }
      }
    } else if (parts[3] === "user") {
      result.user_id = parts[4];
    }

    return result;
  },

  // 生成限流计数器键
  generateRateLimitKey: (params) => {
    const {
      type, // tpm 或 rpm
      tenant_id,
      user_id,
      provider_name,
      model_name,
      window_size = 60,
    } = params;

    const window_start =
      Math.floor(Date.now() / 1000 / window_size) * window_size;

    if (user_id) {
      return CACHE_KEYS.GATEWAY_RATE_LIMIT.USER(user_id, type, window_start);
    }

    if (type === "tpm") {
      return CACHE_KEYS.GATEWAY_RATE_LIMIT.TPM(
        tenant_id,
        provider_name,
        model_name,
        window_start,
      );
    } else {
      return CACHE_KEYS.GATEWAY_RATE_LIMIT.RPM(
        tenant_id,
        provider_name,
        window_start,
      );
    }
  },

  // 构建告警冷却键
  buildAlertCooldownKey: (tenant_id, customer_type) => {
    return CACHE_KEYS.GATEWAY_ALERTS.SOFT_LIMIT_ALERT(tenant_id, customer_type);
  },

  // 检查并设置告警冷却
  checkAndSetAlertCooldown: async (key, ttl = 300) => {
    const exists = await RedisService.kv.get(key);
    if (exists) {
      return false; // 在冷却期内
    }

    await RedisService.kv.set(key, "1", ttl);
    return true; // 可以发送告警
  },

  // 清理所有网关相关缓存（用于配置更新时）
  cleanAllGatewayCaches: async () => {
    // 1. 清理整体配置
    await RedisService.kv.del(CACHE_KEYS.GATEWAY_CONFIG.FULL_PAYLOAD);

    // 2. 清理告警冷却
    const alertKeys = await RedisService.keys("gateway:alert:*");
    if (alertKeys.length > 0) {
      await RedisService.del(...alertKeys);
    }

    // 注意：不清理限流计数器，因为它们有时间窗口自动过期
    logger.info("[CACHE_CLEAN] 网关配置缓存清理完成");
  },
};

module.exports = CACHE_KEYS;
