// packages/neuropia_analytic_service/src/server.js
require('module-alias/register');
require("dotenv").config();

const app = require("./app");

const PORT = process.env.ANALYTICS_PORT || 3002;

async function startServer() {
  try {
    console.log("🚀 Starting Neuropia Analytics Service...");

    const server = app.listen(PORT, () => {
      console.log(`Neuropia Analytics Service running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
    });

    // 优雅关闭
    const gracefulShutdown = async (signal) => {
      console.log(`\n Received ${signal}, shutting down gracefully...`);
      server.close(() => {
        console.log("HTTP server closed");
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    return server;
  } catch (error) {
    console.error("💥 Failed to start Neuropia Analytics Service:", error);
    process.exit(1);
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
