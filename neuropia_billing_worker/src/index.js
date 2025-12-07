// neuropia_billing_worker/src/index.js
require("module-alias/register");
const streamConsumer = require("./streamConsumer");

// 🎯 状态管理
let isShuttingDown = false;
let mainLoopResolve = null;

async function main() {
  console.log("🚀 启动Billing Worker（消费者）...");
  console.log(`📊 进程信息: PID=${process.pid}`);

  try {
    // 🎯 启动消费者
    streamConsumer.startStreamConsumer();

    // 🎯 简单等待一下，让消费者启动完成
    await new Promise((resolve) => setTimeout(resolve, 1000));

    console.log("✅ Billing Worker运行中");
    console.log("📌 按 Ctrl+C 停止服务");

    // 🎯 保持进程运行
    await new Promise((resolve) => {
      mainLoopResolve = resolve;
    });
  } catch (error) {
    console.error("❌ Billing Worker启动失败:", error);
    process.exit(1);
  }
}

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;

  isShuttingDown = true;
  console.log(`\n🛑 收到 ${signal} 信号，开始优雅关闭...`);

  try {
    // 🎯 直接停止消费者（不额外打印日志）
    await streamConsumer.stopConsumer();
  } catch (error) {
    console.error("❌ 停止时出错:", error.message);
  } finally {
    // 🎯 通知主循环退出
    if (mainLoopResolve) {
      mainLoopResolve();
    }

    // 🎯 立即退出
    process.exit(0);
  }
}

// 信号处理
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// 异常处理
process.on("uncaughtException", (error) => {
  console.error("💥 未捕获异常:", error);
  gracefulShutdown("UNCAUGHT_EXCEPTION");
});

process.on("unhandledRejection", (reason) => {
  console.error("💥 未处理的Promise拒绝:", reason);
  gracefulShutdown("UNHANDLED_REJECTION");
});

// 启动
if (require.main === module) {
  main().catch((error) => {
    console.error("💥 应用崩溃:", error);
    process.exit(1);
  });
}
