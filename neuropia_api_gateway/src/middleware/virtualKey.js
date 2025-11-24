// neuropia_api_gateway/src/middleware/virtualKey.js
const { RedisService } = require('../services/redisService');
const { UserService } = require('../services/userService');

class VirtualKeyMiddleware {
    static async validate(req, res, next) {
        try {
            const virtualKey = req.headers['x-virtual-key'];

            if (!virtualKey) {
                return res.status(401).json({
                    error: 'Virtual key required',
                    code: 'MISSING_VIRTUAL_KEY'
                });
            }

            // 从 Redis 获取虚拟密钥配置
            const vkConfig = await RedisService.getVirtualKey(virtualKey);
            if (!vkConfig) {
                return res.status(401).json({
                    error: 'Invalid virtual key',
                    code: 'INVALID_VIRTUAL_KEY'
                });
            }

            // 检查虚拟密钥是否活跃
            if (!vkConfig.is_active) {
                return res.status(403).json({
                    error: 'Virtual key is inactive',
                    code: 'INACTIVE_VIRTUAL_KEY'
                });
            }

            // 检查用户访问权限
            const userAccess = await UserService.checkUserAccess(vkConfig.user_id);
            if (!userAccess.can_use_api) {
                return res.status(403).json({
                    error: 'Access denied',
                    reason: userAccess.message,
                    code: 'USER_ACCESS_DENIED'
                });
            }

            // 检查模型权限（如果请求中有模型参数）
            if (req.body.model && vkConfig.allowed_models && vkConfig.allowed_models.length > 0) {
                if (!vkConfig.allowed_models.includes(req.body.model)) {
                    return res.status(403).json({
                        error: `Model ${req.body.model} not allowed for this virtual key`,
                        code: 'MODEL_NOT_ALLOWED',
                        allowed_models: vkConfig.allowed_models
                    });
                }
            }

            // 注入用户上下文到请求对象
            req.userContext = {
                user_id: vkConfig.user_id,
                virtual_key: virtualKey,
                tenant_id: vkConfig.tenant_id,
                rate_limits: {
                    rpm: vkConfig.rate_limit_rpm,
                    tpm: vkConfig.rate_limit_tpm
                },
                allowed_models: vkConfig.allowed_models
            };

            next();
        } catch (error) {
            console.error('Virtual key validation error:', error);
            res.status(500).json({
                error: 'Internal server error during validation',
                code: 'VALIDATION_ERROR'
            });
        }
    }
}

module.exports = { VirtualKeyMiddleware };
