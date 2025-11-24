// neuropia_config_service/src/app.js
const express = require('express');
const cors = require('cors');
// const helmet = require('helmet'); // 暂时注释掉
const { ConfigManager } = require('./services/configManager');
const { RedisService } = require('./services/redisService');
const { PortkeyConfigGenerator } = require('./services/portkeyConfigGenerator');
const PGListener = require('./listeners/pgListener');

class NeuropiaConfigService {
    constructor() {
        this.app = express();
        // 不在构造函数中初始化
    }

    async initialize() {
        try {
            console.log('Initializing Neuropia Config Service...');

            // 1. 先连接 Redis
            await RedisService.connect();
            console.log('Redis connected successfully');

            // 2. 设置中间件和路由
            this.setupMiddleware();
            this.setupRoutes();

            // 3. 加载配置到 Redis
            await ConfigManager.loadAllConfigs();
            console.log('All configurations loaded to Redis');

            // 4. 启动数据库监听
            await PGListener.connect();
            console.log('Database listener started');

            console.log('Neuropia Config Service initialized successfully');
        } catch (error) {
            console.error('Config Service initialization failed:', error);
            throw error;
        }
    }

    setupMiddleware() {
        // this.app.use(helmet());
        this.app.use(cors());
        this.app.use(express.json());
    }

    setupRoutes() {
        // 配置生成端点
        this.app.post('/generate-config', async (req, res) => {
            try {
                const { userContext, virtualKeyConfig, requestBody } = req.body;

                const config = await PortkeyConfigGenerator.generateConfig(
                    userContext,
                    virtualKeyConfig,
                    requestBody
                );

                res.json({ success: true, config });
            } catch (error) {
                console.error('Config generation error:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // 重新加载配置
        this.app.post('/reload-configs', async (req, res) => {
            try {
                await ConfigManager.loadAllConfigs();
                res.json({ success: true, message: 'Configurations reloaded' });
            } catch (error) {
                console.error('Config reload error:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // 健康检查
        this.app.get('/health', async (req, res) => {
            const redisHealth = await RedisService.healthCheck();

            res.json({
                status: 'ok',
                service: 'neuropia_config_service',
                redis: redisHealth ? 'connected' : 'disconnected',
                timestamp: new Date().toISOString()
            });
        });

        // 获取模型列表
        this.app.get('/models', async (req, res) => {
            try {
                const models = await PortkeyConfigGenerator.loadAllModelConfigs();
                res.json({ success: true, data: models });
            } catch (error) {
                console.error('Get models error:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
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

    async start(port = 3002) {
        try {
            // 异步初始化
            await this.initialize();

            this.server = this.app.listen(port, () => {
                console.log(`Neuropia Config Service running on port ${port}`);
            });

            // 优雅关闭处理
            this.setupGracefulShutdown();

            return this.server;
        } catch (error) {
            console.error('Failed to start Neuropia Config Service:', error);
            process.exit(1);
        }
    }

    setupGracefulShutdown() {
        const gracefulShutdown = async (signal) => {
            console.log(`Received ${signal}, shutting down Config Service gracefully...`);

            // 关闭 HTTP 服务器
            if (this.server) {
                this.server.close(() => {
                    console.log('Config Service HTTP server closed');
                });
            }

            // 关闭 Redis 连接
            if (RedisService.client) {
                await RedisService.client.quit();
                console.log('Config Service Redis connection closed');
            }

            process.exit(0);
        };

        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    }
}

module.exports = NeuropiaConfigService;
