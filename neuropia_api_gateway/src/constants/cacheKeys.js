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

  // ==================== 新增：网关控制配置 ====================
  // Gateway 控制配置
  GATEWAY_CONTROL: {
    // 全局配置（个人用户）
    GLOBAL: (control_type) => `gateway:control:global:${control_type}`,

    // 客户类型配置
    CUSTOMER_TYPE: (customer_type_id, control_type) =>
      `gateway:control:customer_type:${customer_type_id}:${control_type}`,

    // 租户配置 - 基础（不分供应商/模型）
    TENANT_BASE: (tenant_id, control_type) =>
      `gateway:control:tenant:${tenant_id}:${control_type}`,

    // 租户配置 - 按供应商
    TENANT_BY_PROVIDER: (tenant_id, control_type, provider_name) =>
      `gateway:control:tenant:${tenant_id}:${control_type}:${provider_name}`,

    // 租户配置 - 按模型（无供应商）
    TENANT_BY_MODEL: (tenant_id, control_type, model_name) =>
      `gateway:control:tenant:${tenant_id}:${control_type}::${model_name}`,

    // 租户配置 - 按供应商+模型
    TENANT_BY_PROVIDER_MODEL: (
      tenant_id,
      control_type,
      provider_name,
      model_name,
    ) =>
      `gateway:control:tenant:${tenant_id}:${control_type}:${provider_name}:${model_name}`,
  },

  // Gateway 限流计数器
  GATEWAY_RATE_LIMIT: {
    // TPM 计数器
    TPM: (tenant_id, provider_name, model_name, window_start) => {
      let key = `gateway:ratelimit:tpm:${tenant_id}`;
      if (provider_name) key += `:${provider_name}`;
      if (model_name) key += `:${model_name}`;
      return `${key}:${window_start}`;
    },

    // RPM 计数器
    RPM: (tenant_id, provider_name, window_start) => {
      let key = `gateway:ratelimit:rpm:${tenant_id}`;
      if (provider_name) key += `:${provider_name}`;
      return `${key}:${window_start}`;
    },

    // 个人用户 TPM/RPM 计数器
    USER: (user_id, control_type, window_start) =>
      `gateway:ratelimit:${control_type}:user:${user_id}:${window_start}`,
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

  // 网关控制配置TTL - 永不过期（靠notify失效）
  GATEWAY_CONTROL: 0, // 0表示永不过期，只靠notify失效

  // 限流计数器TTL - 自动过期
  RATE_LIMIT_TPM: 120, // 2分钟（比60秒长，确保时间窗口覆盖）
  RATE_LIMIT_RPM: 120,
  RATE_LIMIT_USER: 120,

  // 告警标记TTL（避免重复告警）
  SOFT_LIMIT_ALERT: 300, // 5分钟内不重复告警
};

// 缓存键工具方法
CACHE_KEYS.UTILS = {
  // 生成批量余额查询的键
  bulkBalanceKey: (accountType, accountIds) => {
    const sortedIds = [...accountIds].sort();
    const hash = require("crypto")
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

  // Gateway 相关工具
  isGatewayControlKey: (key) => key.startsWith("gateway:control:"),
  isRateLimitKey: (key) => key.startsWith("gateway:ratelimit:"),

  // 从控制配置键提取信息
  extractFromControlKey: (key) => {
    // gateway:control:{target_type}:{target_id}:{control_type}[:{provider_name}[:{model_name}]]
    const parts = key.split(":");
    if (parts.length < 4) return null;

    const result = {
      target_type: parts[2],
      control_type: parts[4],
    };

    if (parts[2] !== "global") {
      result.target_id = parts[3];
    }

    if (parts.length > 5) {
      result.provider_name = parts[5] || null;
    }

    if (parts.length > 6) {
      result.model_name = parts[6] || null;
    }

    return result;
  },

  // 从限流计数器键提取信息
  extractFromRateLimitKey: (key) => {
    // gateway:ratelimit:{type}:{tenant_id|user_id}[:{provider_name}[:{model_name}]]:{window_start}
    const parts = key.split(":");
    if (parts.length < 5) return null;

    const result = {
      type: parts[2], // tpm 或 rpm
      window_start: parseInt(parts[parts.length - 1]),
    };

    if (parts[3] === "user") {
      result.user_id = parts[4];
    } else {
      result.tenant_id = parts[3];
      if (parts.length > 5 && parts[4]) {
        result.provider_name = parts[4];
      }
      if (parts.length > 6 && parts[5]) {
        result.model_name = parts[5];
      }
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
};

module.exports = CACHE_KEYS;
