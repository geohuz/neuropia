// neuropia_api_gateway/src/app.js
const express = require('express');
const cors = require('cors');
// const helmet = require('helmet'); // 暂时注释掉以简化
const { AuthMiddleware } = require('./middleware/auth');
const { VirtualKeyMiddleware } = require('./middleware/virtualKey');
const chatRoutes = require('./routes/chat');
const configRoutes = require('./routes/config');
const userRoutes = require('./routes/users');
const { RedisService } = require('./services/redisService');

class NeuropiaGateway {
    constructor() {
        this.app = express();
        // 不在构造函数中初始化，改为在 start() 方法中异步初始化
    }

    async initialize() {
        try {
            console.log('Initializing Neuropia API Gateway...');

            // 1. 先连接 Redis
            await RedisService.connect();
            console.log('Redis connected successfully');

            // 2. 设置中间件
            this.setupMiddleware();

            // 3. 设置路由
            this.setupRoutes();

            console.log('Neuropia API Gateway initialized successfully');
        } catch (error) {
            console.error('Initialization failed:', error);
            throw error;
        }
    }

    setupMiddleware() {
        // this.app.use(helmet()); // 暂时注释掉
        this.app.use(cors());
        this.app.use(express.json());

        // 全局认证中间件（健康检查除外）
        this.app.use(AuthMiddleware.authenticate);
    }

    setupRoutes() {
        // 只有聊天路由需要 Virtual Key 验证
        this.app.use('/api/chat', VirtualKeyMiddleware.validate, chatRoutes);

        // 配置和用户路由只需要认证，不需要 Virtual Key
        this.app.use('/api/config', configRoutes);
        this.app.use('/api/users', userRoutes);

        // 健康检查 - 完全公开（包含 Redis 状态）
        this.app.get('/health', async (req, res) => {
            const redisHealth = await RedisService.healthCheck();

            res.json({
                status: 'ok',
                service: 'neuropia_api_gateway',
                redis: redisHealth ? 'connected' : 'disconnected',
                timestamp: new Date().toISOString()
            });
        });

        // 404 处理
        this.app.use('*', (req, res) => {
            res.status(404).json({
                error: 'Route not found',
                code: 'ROUTE_NOT_FOUND'
            });
        });

        // 全局错误处理
        this.app.use((err, req, res, next) => {
            console.error('Unhandled error:', err);
            res.status(500).json({
                error: 'Internal server error',
                code: 'INTERNAL_ERROR'
            });
        });
    }

    async start(port = 3001) {
        try {
            // 异步初始化
            await this.initialize();

            this.server = this.app.listen(port, () => {
                console.log(`Neuropia API Gateway running on port ${port}`);
            });

            // 优雅关闭处理
            this.setupGracefulShutdown();

            return this.server;
        } catch (error) {
            console.error('Failed to start Neuropia API Gateway:', error);
            process.exit(1);
        }
    }

    setupGracefulShutdown() {
        const gracefulShutdown = async (signal) => {
            console.log(`Received ${signal}, shutting down gracefully...`);

            // 关闭 HTTP 服务器
            if (this.server) {
                this.server.close(() => {
                    console.log('HTTP server closed');
                });
            }

            // 关闭 Redis 连接
            if (RedisService.client) {
                await RedisService.client.quit();
                console.log('Redis connection closed');
            }

            process.exit(0);
        };

        // 注册信号处理
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    }
}

module.exports = NeuropiaGateway;
