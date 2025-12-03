// neuropia_api_gateway/src/constants/cacheKeys.js
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

};

module.exports = CACHE_KEYS;
