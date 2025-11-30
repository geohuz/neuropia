// neuropia_config_service/src/server.js
require('module-alias/register');
require("dotenv").config();
const NeuropiaConfigService = require("./app");

async function startServer() {
  try {
    console.log("🚀 Starting Neuropia Config Service...");

    const configService = new NeuropiaConfigService();
    const server = await configService.start(process.env.PORT || 3002);

    console.log("✅ Neuropia Config Service started successfully");

    return server;
  } catch (error) {
    console.error("❌ Failed to start Neuropia Config Service:", error);
    process.exit(1);
  }
}

// 只有直接运行此文件时才启动服务器
if (require.main === module) {
  startServer();
}

module.exports = startServer;
