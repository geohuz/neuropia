// neuropia_api_gateway/src/constants/cacheKeys.js
const CACHE_KEYS = {
    // 虚拟 key 的最终配置
    VIRTUAL_KEY_CONFIG: (virtualKey) => `vk_config:${virtualKey}`,

    // 节点到虚拟 key 的映射
    NODE_VK_MAPPING: (nodeId) => `node_vk_mapping:${nodeId}`,

    // pricing
    VIRTUAL_KEY_PRICING: (vk) => `vk:${vk}:pricing`,
    CUSTOMER_TYPE_PRICING: (ctId) => `price:ct:${ctId}`,
};

module.exports = CACHE_KEYS;
