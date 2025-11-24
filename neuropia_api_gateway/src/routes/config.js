// neuropia_api_gateway/src/routes/config.js
const express = require('express');
const { RedisService } = require('../services/redisService');
const router = express.Router();

/**
 * 配置管理路由
 * 提供配置查询、验证和重新加载功能
 */

// 获取 Virtual Key 配置
router.get('/virtual-keys/:virtualKey', async (req, res) => {
    try {
        const { virtualKey } = req.params;

        const config = await RedisService.getVirtualKey(virtualKey);
        if (!config) {
            return res.status(404).json({
                error: 'Virtual key not found',
                code: 'VIRTUAL_KEY_NOT_FOUND'
            });
        }

        // 过滤敏感信息
        const safeConfig = {
            virtual_key: config.virtual_key,
            name: config.name,
            description: config.description,
            rate_limits: {
                rpm: config.rate_limit_rpm,
                tpm: config.rate_limit_tpm
            },
            allowed_models: config.allowed_models,
            is_active: config.is_active,
            created_at: config.created_at
        };

        res.json(safeConfig);
    } catch (error) {
        console.error('Get virtual key config error:', error);
        res.status(500).json({
            error: 'Failed to get virtual key configuration',
            details: error.message
        });
    }
});

// 验证 Virtual Key
router.post('/virtual-keys/validate', async (req, res) => {
    try {
        const { virtual_key, model } = req.body;

        if (!virtual_key) {
            return res.status(400).json({
                error: 'Virtual key is required',
                code: 'MISSING_VIRTUAL_KEY'
            });
        }

        const config = await RedisService.getVirtualKey(virtual_key);
        if (!config) {
            return res.status(401).json({
                error: 'Invalid virtual key',
                code: 'INVALID_VIRTUAL_KEY'
            });
        }

        if (!config.is_active) {
            return res.status(403).json({
                error: 'Virtual key is inactive',
                code: 'INACTIVE_VIRTUAL_KEY'
            });
        }

        // 检查模型权限
        if (model && config.allowed_models && config.allowed_models.length > 0) {
            if (!config.allowed_models.includes(model)) {
                return res.status(403).json({
                    error: `Model ${model} not allowed for this virtual key`,
                    code: 'MODEL_NOT_ALLOWED',
                    allowed_models: config.allowed_models
                });
            }
        }

        res.json({
            valid: true,
            virtual_key: config.virtual_key,
            name: config.name,
            rate_limits: {
                rpm: config.rate_limit_rpm,
                tpm: config.rate_limit_tpm
            },
            allowed_models: config.allowed_models
        });
    } catch (error) {
        console.error('Validate virtual key error:', error);
        res.status(500).json({
            error: 'Validation failed',
            details: error.message
        });
    }
});

// 获取用户配置上下文
router.get('/user-context/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        // 调用 PostgREST 获取用户完整上下文
        const response = await fetch(
            `${process.env.POSTGREST_URL}/rpc/get_user_context?p_user_id=eq.${userId}`,
            {
                headers: {
                    'Authorization': req.headers.authorization,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (!response.ok) {
            throw new Error(`PostgREST error: ${response.statusText}`);
        }

        const userContext = await response.json();

        if (!userContext || userContext.length === 0) {
            return res.status(404).json({
                error: 'User context not found',
                code: 'USER_CONTEXT_NOT_FOUND'
            });
        }

        res.json(userContext[0]);
    } catch (error) {
        console.error('Get user context error:', error);
        res.status(500).json({
            error: 'Failed to get user context',
            details: error.message
        });
    }
});

// 重新加载配置到 Redis
router.post('/reload', async (req, res) => {
    try {
        const { config_type, config_id } = req.body;

        // 调用配置服务重新加载配置
        const response = await fetch(
            `${process.env.CONFIG_SERVICE_URL}/reload`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ config_type, config_id })
            }
        );

        if (!response.ok) {
            throw new Error(`Config service error: ${response.statusText}`);
        }

        const result = await response.json();

        res.json({
            success: true,
            message: 'Configuration reloaded successfully',
            ...result
        });
    } catch (error) {
        console.error('Reload config error:', error);
        res.status(500).json({
            error: 'Failed to reload configuration',
            details: error.message
        });
    }
});

// 获取系统状态
router.get('/status', async (req, res) => {
    try {
        const status = {
            service: 'neuropia_api_gateway',
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV || 'development',
            redis: {
                connected: RedisService.client?.isOpen || false
            },
            config_service: 'unknown'
        };

        // 检查配置服务状态
        try {
            const configServiceResponse = await fetch(
                `${process.env.CONFIG_SERVICE_URL}/health`
            );
            status.config_service = configServiceResponse.ok ? 'healthy' : 'unhealthy';
        } catch (error) {
            status.config_service = 'unreachable';
        }

        res.json(status);
    } catch (error) {
        console.error('Get status error:', error);
        res.status(500).json({
            error: 'Failed to get system status',
            details: error.message
        });
    }
});

module.exports = router;
