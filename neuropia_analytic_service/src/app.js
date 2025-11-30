// neuropia_analytic_service/src/app.js
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
// 导入路由
const analyticsRoutes = require("./routes/analytics");
const Redis = require("@shared/clients/redis_op");

const app = express();

// 中间件
app.use(helmet());
app.use(cors());
app.use(express.json());

// Redis 客户端（专用）
let redisClient = null;

async function initializeRedis() {
  redisClient = createClient({
    url: process.env.REDIS_URL || "redis://localhost:6379",
  });

  redisClient.on("error", (err) => console.error("Redis Error:", err));
  await redisClient.connect();
  console.log("✅ Analytics Service Redis connected");
  return redisClient;
}

// 健康检查
app.get("/health", async (req, res) => {
  try {
    const client = await initializeRedis();
    await client.ping();
    res.json({
      status: "healthy",
      service: "neuropia_analytic_service",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: "unhealthy",
      error: error.message,
    });
  }
});

app.use("/", analyticsRoutes);

module.exports = app;
