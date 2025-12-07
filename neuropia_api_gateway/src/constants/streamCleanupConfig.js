module.exports = {
  // 时间间隔（毫秒）
  intervals: {
    // 🎯 默认改为24小时清理一次，而不是1小时
    cleanup:
      parseInt(process.env.STREAM_CLEANUP_INTERVAL) || 24 * 60 * 60 * 1000,
    initialDelay: parseInt(process.env.STREAM_INITIAL_DELAY) || 30 * 60 * 1000,
  },
  // 清理参数
  settings: {
    maxAgeHours: parseInt(process.env.STREAM_MAX_AGE_HOURS) || 24,
    maxPerShard: parseInt(process.env.STREAM_MAX_PER_SHARD) || 1000,
  },
};
