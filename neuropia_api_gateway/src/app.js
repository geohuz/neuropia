// neuropia_api_gateway/src/app.js
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

// 中间件
const { VirtualKeyMiddleware } = require("./middleware/virtualKey");
const ErrorHandler = require("./middleware/errorHandler");
const RequestLogger = require("./middleware/requestLogger");

// 路由
const proxyRoutes = require("./routes/proxy");

// 服务
const RedisService = require("@shared/clients/redis_op");
const configCacheManager = require("./services/configCacheManager");
const pricingCacheManager = require("./services/pricingCacheManager");

let server = null;
let initialized = false;

async function initialize() {
    if (initialized) return;

    try {
        console.log("🚀 Initializing Neuropia API Gateway...");

        // 1. 连接 Redis
        await RedisService.connect();
        console.log("✅ Redis connected successfully");

        // 2. 初始化配置缓存管理器
        await configCacheManager.initialize()
        console.log("✅ configCacheManager initialized");
        //
        // 2. 初始化价格缓存管理器
        await pricingCacheManager.initialize()
        console.log("✅ pricingCacheManager initialized");

        initialized = true;
        console.log("Neuropia API Gateway initialized successfully");
    } catch (error) {
        console.error("❌ Initialization failed:", error);
        throw error;
    }
}

function setupMiddleware(app) {
    // 健康检查 - 公开访问
    app.get("/health", healthCheck);

    // 安全中间件
    app.use(helmet());
    app.use(cors({
        origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
        credentials: true
    }));

    // 请求解析
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true }));

    // 请求日志
    app.use(RequestLogger);

    // 全局速率限制
    const globalLimiter = rateLimit({
        windowMs: 1 * 60 * 1000, // 1分钟
        max: 100, // 最多100个请求
        message: {
            error: "Too many requests, please try again later.",
            code: "RATE_LIMIT_EXCEEDED"
        },
        standardHeaders: true,
        legacyHeaders: false
    });
    app.use(globalLimiter);

}

function setupRoutes(app) {
    // API 路由
    app.use("/v1", VirtualKeyMiddleware.validate, proxyRoutes);

    // 404 处理
    app.use("*", handleNotFound);
}

function setupErrorHandling(app) {
    app.use(ErrorHandler);
}

async function healthCheck(req, res) {
    const startTime = Date.now();

    try {
        // 使用独立连接，避免单例客户端的问题
        const { createClient } = require("redis");
        const healthClient = createClient({
            url: process.env.REDIS_URL || "redis://localhost:6379",
        });

        await healthClient.connect();
        const pingStart = Date.now();
        const result = await healthClient.ping();
        const pingTime = Date.now() - pingStart;
        await healthClient.disconnect();

        const totalTime = Date.now() - startTime;

        res.status(200).json({
            status: 'healthy',
            response_time: totalTime,
            redis_ping_time: pingTime,
            note: "Used dedicated Redis connection"
        });

    } catch (error) {
        const totalTime = Date.now() - startTime;
        res.status(200).json({
            status: 'degraded',
            response_time: totalTime,
            error: error.message
        });
    }
}

function handleNotFound(req, res) {
    res.status(404).json({
        error: "Route not found",
        code: "ROUTE_NOT_FOUND",
        path: req.originalUrl
    });
}

function setupGracefulShutdown() {
    const gracefulShutdown = async (signal) => {
        console.log(`\n Received ${signal}, shutting down gracefully...`);

        if (server) {
            server.close(() => {
                console.log("HTTP server closed");
            });
        }

        // 只关闭确实存在的服务
        await Promise.allSettled([
            configCacheManager.stop().then(() => console.log("configCacheManager shutdown")),
            RedisService.disconnect().then(() => console.log("Redis disconnected"))
        ]);

        console.log("Graceful shutdown completed");
        process.exit(0);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

async function stop() {
    if (server) {
        server.close();
    }
    await configCacheManager.stop();
    await RedisService.disconnect();
}

async function start(port = process.env.PORT || 3001) {
    try {
        await initialize();

        const app = express();

        setupMiddleware(app);
        setupRoutes(app);
        setupErrorHandling(app);

        server = app.listen(port, () => {
            console.log(`Neuropia API Gateway running on port ${port}`);
            console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`Health check: http://localhost:${port}/health`);
        });

        setupGracefulShutdown();
        return server;
    } catch (error) {
        console.error("💥 Failed to start Neuropia API Gateway:", error);
        throw error;
    }
}

module.exports = {
    start,
    stop,
    healthCheck,
    handleNotFound
};
