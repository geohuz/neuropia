// neuropia_api_gateway/src/services/schedulerService.js
const StreamService = require("./streamService");
const CONFIG = require("@shared/config").streaming.scheduler;

class SchedulerService {
  // 🔴 集中所有常量在这里
  // static CONFIG = {
  //   // 时间间隔（毫秒）
  //   intervals: {
  //     cleanup: 60 * 60 * 1000, // 1小时清理一次
  //     monitoring: 5 * 60 * 1000, // 5分钟监控一次
  //     initialDelay: 30 * 60 * 1000, // 首次清理延迟30分钟
  //   },

  //   // 清理配置
  //   cleanup: {
  //     maxAgeHours: 24, // 清理24小时前的消息
  //     maxPerShard: 1000, // 每次最多清理1000条/分片
  //   },

  //   // 监控阈值
  //   thresholds: {
  //     backlog: 50000, // 积压超过5万条报警
  //     shardImbalance: 10, // 分片不均衡超过10倍
  //   },

  //   // 报警配置
  //   alerts: {
  //     enabled: false, // TODO: 启用报警
  //     levels: ["warning", "critical"],
  //   },
  // };

  constructor() {
    this.intervals = new Map();
    this.isRunning = false;
    this.config = CONFIG;
  }

  /**
   * 启动所有定时任务
   */
  startAll() {
    if (this.isRunning) {
      console.warn("定时任务已在运行中");
      return;
    }

    console.log("🚀 启动定时任务...");

    // 1. Stream清理任务
    this._startStreamCleanup();

    // 2. Stream监控任务
    this._startStreamMonitoring();

    this.isRunning = true;
    console.log("✅ 定时任务启动完成");
  }

  /**
   * 停止所有定时任务
   */
  stopAll() {
    console.log("🛑 停止定时任务...");

    for (const [name, intervalId] of this.intervals.entries()) {
      clearInterval(intervalId);
      console.log(`已停止: ${name}`);
    }

    this.intervals.clear();
    this.isRunning = false;
    console.log("✅ 定时任务已停止");
  }

  /**
   * 启动Stream清理任务
   */
  _startStreamCleanup() {
    const TASK_NAME = "stream_cleanup";
    const config = this.config;

    // 延迟执行第一次清理
    setTimeout(() => {
      this._executeStreamCleanup();
    }, config.intervals.initialDelay);

    // 设置定时器
    const intervalId = setInterval(() => {
      this._executeStreamCleanup();
    }, config.intervals.cleanup);

    this.intervals.set(TASK_NAME, intervalId);
    console.log(`${TASK_NAME} 已启动，首次延迟30分钟，之后间隔1小时`);
  }

  /**
   * 执行Stream清理
   */
  async _executeStreamCleanup() {
    const startTime = Date.now();
    const config = this.config;

    try {
      console.log("🧹 开始清理Stream旧消息...");

      const result = await StreamService.cleanupOldMessages(
        config.cleanup.maxAgeHours,
        config.cleanup.maxPerShard,
      );

      const duration = Date.now() - startTime;

      if (result.total_cleaned > 0) {
        console.log(
          `Stream清理完成，清理 ${result.total_cleaned} 条消息，耗时 ${duration}ms`,
        );
      } else {
        console.log(`Stream无旧消息可清理，耗时 ${duration}ms`);
      }
    } catch (error) {
      console.error("❌ Stream清理失败:", error);
    }
  }

  /**
   * 启动Stream监控任务
   */
  _startStreamMonitoring() {
    const TASK_NAME = "stream_monitoring";
    const config = this.config;

    // 立即执行一次监控
    this._executeStreamMonitoring();

    // 设置定时器
    const intervalId = setInterval(() => {
      this._executeStreamMonitoring();
    }, config.intervals.monitoring);

    this.intervals.set(TASK_NAME, intervalId);
    console.log(`⏰ ${TASK_NAME} 已启动，间隔5分钟`);
  }

  /**
   * 执行Stream监控
   */
  async _executeStreamMonitoring() {
    const startTime = Date.now();
    const config = this.config;

    try {
      console.log("📊 检查Stream状态...");

      const stats = await StreamService.getStreamStats();
      const duration = Date.now() - startTime;

      // 基础日志
      console.log(
        `📊 Stream状态: 历史消息=${stats.total_messages}, 待处理=${stats.pending_messages || 0}, 延迟=${stats.consumer_lag || 0}ms, ${stats.active_shards}/${stats.total_shards}活跃分片, 耗时 ${duration}ms`,
      );

      // 检查异常情况
      const alerts = this._checkStreamAlerts(stats);

      if (alerts.length > 0) {
        alerts.forEach((alert) => {
          console.warn(`⚠️ ${alert.level.toUpperCase()}: ${alert.message}`);
        });
      }
    } catch (error) {
      console.error("❌ Stream监控失败:", error);
    }
  }

  /**
   * 检查Stream异常并生成报警
   */
  _checkStreamAlerts(stats) {
    const alerts = [];
    const config = this.config;

    // 1. 消息积压过多
    if ((stats.pending_message || 0) > config.thresholds.backlog) {
      alerts.push({
        level: "warning",
        type: "stream_backlog",
        message: `Stream消息积压过多: ${stats.total_messages} 条`,
        threshold: config.thresholds.backlog,
        actual: stats.total_messages,
      });
    }

    // 2. 分片消息分布不均
    const maxShardMessages = Math.max(
      ...stats.shards.map((s) => s.length || 0),
    );
    const minShardMessages = Math.min(
      ...stats.shards.map((s) => s.length || 0),
    );

    if (maxShardMessages > 0 && minShardMessages > 0) {
      const ratio = maxShardMessages / minShardMessages;
      if (ratio > config.thresholds.shardImbalance) {
        alerts.push({
          level: "warning",
          type: "shard_imbalance",
          message: `Stream分片负载不均衡，最大/最小分片消息比: ${ratio.toFixed(2)}`,
          max_shard: maxShardMessages,
          min_shard: minShardMessages,
          ratio: ratio,
        });
      }
    }

    return alerts;
  }

  /**
   * 获取当前运行状态
   */
  getStatus() {
    return {
      is_running: this.isRunning,
      active_tasks: Array.from(this.intervals.keys()),
      task_count: this.intervals.size,
      config: this.config, // 返回配置供调试
    };
  }
}

// 创建单例
const schedulerService = new SchedulerService();

// 优雅关闭处理
process.on("SIGTERM", () => {
  console.log("收到 SIGTERM 信号，停止定时任务...");
  schedulerService.stopAll();
});

process.on("SIGINT", () => {
  console.log("收到 SIGINT 信号，停止定时任务...");
  schedulerService.stopAll();
});

module.exports = schedulerService;
