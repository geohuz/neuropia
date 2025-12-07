// Stream消费者配置（给 billing_worker 用）
module.exports = {
  // Stream配置
  streamPrefix: process.env.STREAM_PREFIX || "stream:deductions",
  numShards: parseInt(process.env.STREAM_NUM_SHARDS) || 16,
  consumerGroup: process.env.STREAM_CONSUMER_GROUP || "billing_workers",

  // 消费策略
  batchSize: parseInt(process.env.STREAM_BATCH_SIZE) || 50, // 每批处理50条
  pollInterval: parseInt(process.env.STREAM_POLL_INTERVAL) || 100, // 轮询间隔100ms
  blockTime: parseInt(process.env.STREAM_BLOCK_TIME) || 5000, // 阻塞读取超时5秒

  // 重试策略
  maxRetries: parseInt(process.env.STREAM_MAX_RETRIES) || 3, // 最大重试次数
  retryDelay: parseInt(process.env.STREAM_RETRY_DELAY) || 1000, // 重试延迟1秒

  // 监控（预留stub）
  enableMetrics: process.env.STREAM_ENABLE_METRICS === "true",
  enableDeadLetter: process.env.STREAM_ENABLE_DEAD_LETTER === "true",
};
