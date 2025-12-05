// neuropia_api_gateway/src/server.js
require("module-alias/register");
const gateway = require("./app");

async function startServer() {
  try {
    console.log("🚀 Starting Neuropia API Gateway...");

    // 去掉 new，直接调用 start 函数
    const server = await gateway.start(process.env.PORT || 3001);

    console.log("✅ Neuropia API Gateway started successfully");

    return server;
  } catch (error) {
    console.error("❌ Failed to start Neuropia API Gateway:", error);
    // 不要调用 process.exit，让调用方处理错误
    throw error;
  }
}

// 只有直接运行此文件时才启动服务器
if (require.main === module) {
  startServer().catch((error) => {
    console.error("Server startup failed:", error);
    process.exit(1);
  });
}

module.exports = startServer;
