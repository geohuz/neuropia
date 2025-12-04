// 所有需要监听的pg_notify频道
const PG_NOTIFY_CHANNELS = {
  // 价格相关
  CUSTOMER_TYPE_RATE_UPDATE: "customer_type_rate_update",

  // 账户余额相关
  ACCOUNT_BALANCE_UPDATED: "account_balance_updated",

  // 节点管理相关
  NODE_CHANGED: "node_changed",

  // 虚拟密钥相关
  VIRTUAL_KEY_CONFIG_CHANGED: "virtual_key_config_changed",

  // 其他频道...
};

// 获取所有频道数组
const ALL_CHANNELS = Object.values(PG_NOTIFY_CHANNELS);

module.exports = {
  ALL_CHANNELS,
};
