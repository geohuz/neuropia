// shared/config/streaming.js
module.exports = {
  // Stream消费者配置（给 billing_worker 用）
  consumer: {
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
  },

  // 定时任务配置（给 SchedulerService 用）
  scheduler: {
    // 时间间隔（毫秒）
    intervals: {
      cleanup: parseInt(process.env.STREAM_CLEANUP_INTERVAL) || 60 * 60 * 1000, // 1小时
      monitoring:
        parseInt(process.env.STREAM_MONITORING_INTERVAL) || 5 * 60 * 1000, // 5分钟
      initialDelay:
        parseInt(process.env.STREAM_INITIAL_DELAY) || 30 * 60 * 1000, // 30分钟
    },

    // 清理配置
    cleanup: {
      maxAgeHours: parseInt(process.env.STREAM_MAX_AGE_HOURS) || 24, // 清理24小时前的消息
      maxPerShard: parseInt(process.env.STREAM_MAX_PER_SHARD) || 1000, // 每次最多清理1000条/分片
    },

    // 监控阈值
    thresholds: {
      backlog: parseInt(process.env.STREAM_BACKLOG_THRESHOLD) || 50000, // 积压超过5万条报警
      shardImbalance: parseInt(process.env.STREAM_SHARD_IMBALANCE) || 10, // 分片不均衡超过10倍
    },

    // 报警配置
    alerts: {
      enabled: process.env.STREAM_ALERTS_ENABLED === "true",
      levels: process.env.STREAM_ALERT_LEVELS?.split(",") || [
        "warning",
        "critical",
      ],
    },
  },
};
