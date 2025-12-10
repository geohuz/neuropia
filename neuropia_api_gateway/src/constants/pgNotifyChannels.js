// 所有需要监听的pg_notify频道
const ALL_CHANNELS = {
  // 价格相关
  CUSTOMER_TYPE_RATE_UPDATE: "customer_type_rate_update",

  // 账户余额相关
  ACCOUNT_BALANCE_UPDATED: "account_balance_updated",

  // 节点管理相关
  NODE_CHANGED: "node_changed",

  // 虚拟密钥相关
  VIRTUAL_KEY_CONFIG_CHANGED: "virtual_key_config_changed",

  // 网关控制配置变更
  GATEWAY_CONTROL_CHANGES: "gateway_control_changes",
};

module.exports = ALL_CHANNELS;
