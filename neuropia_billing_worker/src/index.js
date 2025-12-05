// neuropia_billing_worker/src/index.js
require("module-alias/register");
const streamConsumer = require("./streamConsumer");
const SchedulerService = require("@shared/services/streamScheduleWorker");

async function main() {
  console.log("🚀 启动Billing Worker...");

  try {
    // 1. 启动Stream消费者
    console.log("🔄 启动Stream消费者...");
    await streamConsumer.startStreamConsumer();

    // 2. 启动定时任务（清理和监控Stream）
    console.log("🔄 启动定时任务...");
    SchedulerService.startAll();

    console.log("✅ Billing Worker运行中");

    // 保持进程运行
    await new Promise(() => {});
  } catch (error) {
    console.error("❌ Billing Worker失败:", error);
    process.exit(1);
  }
}

// 启动
main();
