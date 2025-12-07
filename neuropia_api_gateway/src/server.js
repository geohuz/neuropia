// neuropia_api_gateway/src/server.js
require("module-alias/register");
const logger = require("@shared/utils/logger");
const gateway = require("./app");

async function startServer() {
  try {
    logger.info("🚀 Starting Neuropia API Gateway...");

    // 去掉 new，直接调用 start 函数
    const server = await gateway.start(process.env.PORT || 3001);
    return server;
  } catch (error) {
    logger.error("❌ Failed to start Neuropia API Gateway:", {
      error: error.message,
      stack: error.stack,
    });
    // 不要调用 process.exit，让调用方处理错误
    throw error;
  }
}

// 只有直接运行此文件时才启动服务器
if (require.main === module) {
  startServer().catch((error) => {
    logger.error("Server startup failed:", {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  });
}

module.exports = startServer;
