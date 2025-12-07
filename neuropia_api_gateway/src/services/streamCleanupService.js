// neuropia_api_gateway/src/services/streamCleanupService.js
const StreamService = require("./streamService");
const CONFIG = require("../constants/streamCleanupConfig");

class StreamCleanupService {
  constructor() {
    this.interval = null;
    this.isRunning = false;

    // 🎯 使用配置中的清理参数
    this.config = {
      // 清理间隔：使用配置或默认24小时
      cleanupInterval: CONFIG.intervals.cleanup || 24 * 60 * 60 * 1000,
      initialDelay: CONFIG.intervals.initialDelay || 30 * 60 * 1000,

      // 清理参数：使用配置或默认值
      maxAgeHours: CONFIG.settings.maxAgeHours || 24,
      maxPerShard: CONFIG.settings.maxPerShard || 1000,
    };

    console.log("🧹 Stream清理服务初始化", {
      清理间隔: `${this.config.cleanupInterval / (60 * 60 * 1000)}小时`,
      首次延迟: `${this.config.initialDelay / (60 * 1000)}分钟`,
      保留时长: `${this.config.maxAgeHours}小时`,
    });
  }

  /**
   * 启动清理服务
   */
  start() {
    if (this.isRunning) {
      console.warn("清理服务已在运行中");
      return;
    }

    console.log("🚀 启动Stream自动清理服务");
    this.isRunning = true;

    // 延迟首次执行
    setTimeout(() => this.doCleanup(), this.config.initialDelay);

    // 定时执行
    this.interval = setInterval(
      () => this.doCleanup(),
      this.config.cleanupInterval,
    );

    console.log(
      `📅 清理计划: 首次${this.config.initialDelay / 60000}分钟后，之后每${this.config.cleanupInterval / (60 * 60 * 1000)}小时`,
    );
  }

  /**
   * 执行清理
   */
  async doCleanup() {
    const startTime = Date.now();

    try {
      console.log("🧹 开始清理Stream旧消息...");

      const result = await StreamService.cleanupOldMessages(
        this.config.maxAgeHours,
        this.config.maxPerShard,
      );

      const duration = Date.now() - startTime;

      if (result.total_cleaned > 0) {
        console.log(
          `✅ 清理完成: ${result.total_cleaned} 条消息，耗时 ${duration}ms`,
        );

        // 简单错误检查
        if (result.errors && result.errors.length > 0) {
          console.warn(`⚠️ 清理时 ${result.errors.length} 个分片出错`);
        }
      } else {
        console.log(`📭 无旧消息可清理，耗时 ${duration}ms`);
      }

      return result;
    } catch (error) {
      console.error("❌ Stream清理失败:", error.message);
      throw error;
    }
  }

  /**
   * 手动执行一次清理（用于测试或紧急清理）
   */
  async manualCleanup(maxAgeHours, maxPerShard) {
    console.log("🔧 手动执行Stream清理...");

    return await StreamService.cleanupOldMessages(
      maxAgeHours || this.config.maxAgeHours,
      maxPerShard || this.config.maxPerShard,
    );
  }

  /**
   * 停止清理服务
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    this.isRunning = false;
    console.log("🛑 Stream清理服务已停止");
  }

  /**
   * 获取服务状态
   */
  getStatus() {
    return {
      is_running: this.isRunning,
      service: "stream_cleanup",
      config: {
        cleanup_interval_hours: this.config.cleanupInterval / (60 * 60 * 1000),
        max_age_hours: this.config.maxAgeHours,
        max_per_shard: this.config.maxPerShard,
      },
      next_cleanup: this.isRunning ? "按计划执行" : "已停止",
    };
  }
}

// 创建单例
const cleanupService = new StreamCleanupService();

module.exports = cleanupService;
