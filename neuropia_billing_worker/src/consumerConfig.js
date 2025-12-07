// consumerConfig.js
module.exports = {
  batchMode: process.env.STREAM_BATCH_MODE || "on",
  // Stream配置
  streamPrefix: process.env.STREAM_PREFIX || "stream:deductions",
  numShards: parseInt(process.env.STREAM_SHARD_COUNT) || 16, // 使用 STREAM_SHARD_COUNT
  consumerGroup: process.env.STREAM_CONSUMER_GROUP || "billing_workers",

  // 消费策略
  batchSize: parseInt(process.env.CONSUMER_BATCH_SIZE) || 50, // 使用 CONSUMER_BATCH_SIZE
  pollInterval: parseInt(process.env.CONSUMER_POLL_INTERVAL_MS) || 100, // 使用 CONSUMER_POLL_INTERVAL_MS
  blockTime: parseInt(process.env.CONSUMER_BLOCK_TIME_MS) || 5000, // 使用 CONSUMER_BLOCK_TIME_MS
  parallelShards: parseInt(process.env.CONSUMER_PARALLEL_SHARDS) || 1, // 新增并行分片

  // 重试策略
  maxRetries: parseInt(process.env.STREAM_MAX_RETRIES) || 3,
  retryDelay: parseInt(process.env.STREAM_RETRY_DELAY) || 1000,

  // 监控
  enableMetrics: process.env.STREAM_ENABLE_METRICS === "true",
  enableDeadLetter: process.env.STREAM_ENABLE_DEAD_LETTER === "true",
};
