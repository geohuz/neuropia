require("module-alias/register");

// neuropia_billing_worker/src/index.js
const flushBalances = require("./balanceFlusher");
const flushUsage = require("./usageFlusher");

const FLUSH_INTERVAL = 5000; // 5 秒

setInterval(async () => {
  try {
    await flushBalances();
  } catch (err) {
    console.error("❌ flushBalances failed:", err);
  }
}, FLUSH_INTERVAL);

setInterval(async () => {
  try {
    await flushUsage();
  } catch (err) {
    console.error("❌ flushUsage failed:", err);
  }
}, FLUSH_INTERVAL);

console.log("✅ neuropia_billing_worker started");
