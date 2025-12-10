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
};

module.exports = CACHE_KEYS;
