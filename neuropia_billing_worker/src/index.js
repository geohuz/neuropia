// neuropia_billing_worker/src/index.js
require("module-alias/register");
const streamConsumer = require("./streamConsumer");
const SchedulerService = require("@shared/services/streamScheduleWorker");

// 全局状态管理
let isShuttingDown = false;
let shutdownResolver = null;

/**
 * 优雅关闭处理
 */
async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    console.log("⏳ 关闭已在处理中...");
    return;
  }

  isShuttingDown = true;
  console.log(`\n🛑 收到 ${signal} 信号，开始优雅关闭...`);

  try {
    const shutdownPromises = [];

    // 1. 停止Stream消费者（如果可用）
    if (typeof streamConsumer.stopConsumer === "function") {
      console.log("⏳ 停止Stream消费者...");
      shutdownPromises.push(
        streamConsumer.stopConsumer().catch((err) => {
          console.error("❌ 停止Stream消费者失败:", err.message);
        }),
      );
    }

    // 2. 停止定时任务（如果可用）
    if (typeof SchedulerService.stopAll === "function") {
      console.log("⏳ 停止定时任务...");
      shutdownPromises.push(
        Promise.resolve(SchedulerService.stopAll()).catch((err) => {
          console.error("❌ 停止定时任务失败:", err.message);
        }),
      );
    }

    // 等待所有服务停止（最多15秒）
    if (shutdownPromises.length > 0) {
      await Promise.race([
        Promise.all(shutdownPromises),
        new Promise((resolve) => setTimeout(resolve, 15000)),
      ]);
    }

    console.log("✅ 所有服务已停止");
  } catch (error) {
    console.error("❌ 优雅关闭过程中出错:", error.message);
  } finally {
    // 通知主循环可以退出了
    if (shutdownResolver) {
      shutdownResolver();
    }

    // 3秒后强制退出，防止卡住
    setTimeout(() => {
      console.log("⚠️  强制退出进程");
      process.exit(0);
    }, 3000);
  }
}

/**
 * 设置信号处理
 */
function setupSignalHandlers() {
  // SIGINT: Ctrl+C
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  // SIGTERM: kill命令
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  // 其他信号处理
  process.on("SIGUSR2", () => {
    console.log("📝 收到SIGUSR2，重新加载配置...");
    // 可以在这里添加配置重载逻辑
  });

  // 防止未捕获异常导致进程崩溃
  process.on("uncaughtException", (error) => {
    console.error("💥 未捕获异常:", error);
    gracefulShutdown("UNCAUGHT_EXCEPTION");
  });

  process.on("unhandledRejection", (reason, promise) => {
    console.error("💥 未处理的Promise拒绝:", reason);
    gracefulShutdown("UNHANDLED_REJECTION");
  });
}

/**
 * 健康检查
 */
function setupHealthCheck() {
  let isHealthy = true;
  let lastActivity = Date.now();

  // 定期检查进程状态
  setInterval(() => {
    const inactiveTime = Date.now() - lastActivity;

    // 如果超过5分钟没有活动，记录警告
    if (inactiveTime > 5 * 60 * 1000 && !isShuttingDown) {
      console.warn(`⚠️  进程已 ${Math.floor(inactiveTime / 1000)} 秒没有活动`);
    }
  }, 60000); // 每分钟检查一次

  return {
    updateActivity: () => {
      lastActivity = Date.now();
    },
    getStatus: () => ({
      healthy: isHealthy,
      uptime: process.uptime(),
      lastActivity: new Date(lastActivity).toISOString(),
      memory: process.memoryUsage(),
    }),
  };
}

/**
 * 主函数
 */
async function main() {
  console.log("🚀 启动Billing Worker...");
  console.log(
    `📊 进程信息: PID=${process.pid}, NODE_ENV=${process.env.NODE_ENV || "development"}`,
  );

  // 设置信号处理
  setupSignalHandlers();

  // 设置健康检查
  const healthCheck = setupHealthCheck();

  try {
    // 1. 启动Stream消费者
    console.log("🔄 启动Stream消费者...");
    const consumerPromise = streamConsumer.startStreamConsumer();

    // 2. 启动定时任务（清理和监控Stream）
    console.log("🔄 启动定时任务...");
    SchedulerService.startAll();

    // 等待消费者启动完成
    await consumerPromise;

    console.log("✅ Billing Worker运行中");
    console.log("📌 按 Ctrl+C 停止服务");

    // 3. 主循环 - 使用事件监听而不是阻塞Promise
    await new Promise((resolve) => {
      shutdownResolver = resolve;
      // 定期更新活动时间
      const activityInterval = setInterval(() => {
        healthCheck.updateActivity();
      }, 30000);

      // 清理定时器
      process.once("beforeExit", () => {
        clearInterval(activityInterval);
      });
    });

    console.log("👋 主循环已退出，准备关闭...");
  } catch (error) {
    console.error("❌ Billing Worker启动失败:", error);

    // 尝试优雅关闭
    if (!isShuttingDown) {
      await gracefulShutdown("STARTUP_FAILURE");
    }

    process.exit(1);
  }
}

// 启动应用
if (require.main === module) {
  main().catch((error) => {
    console.error("💥 应用崩溃:", error);
    process.exit(1);
  });
}

// 导出用于测试
module.exports = {
  main,
  gracefulShutdown,
  setupSignalHandlers,
};
