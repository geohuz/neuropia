// neuropia_api_gateway/src/services/userService.js
const { RedisService } = require('./redisService');

class UserService {
    /**
     * 检查用户访问权限
     */
    static async checkUserAccess(userId) {
        try {
            // 调用 PostgREST 检查用户权限
            const response = await fetch(
                `${process.env.POSTGREST_URL}/rpc/check_user_access`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        p_user_id: userId
                    })
                }
            );

            if (!response.ok) {
                throw new Error(`PostgREST error: ${response.statusText}`);
            }

            const result = await response.json();

            if (!result || result.length === 0) {
                return {
                    can_use_api: false,
                    can_generate_key: false,
                    user_status: 'unknown',
                    message: 'User not found'
                };
            }

            return result[0];
        } catch (error) {
            console.error('Check user access error:', error);
            throw error;
        }
    }

    /**
     * 获取用户完整上下文信息
     */
    static async getUserContext(userId) {
        try {
            const response = await fetch(
                `${process.env.POSTGREST_URL}/rpc/get_user_context?p_user_id=eq.${userId}`
            );

            if (!response.ok) {
                throw new Error(`PostgREST error: ${response.statusText}`);
            }

            const result = await response.json();
            return result.length > 0 ? result[0] : null;
        } catch (error) {
            console.error('Get user context error:', error);
            throw error;
        }
    }

    /**
     * 验证用户余额是否足够
     */
    static async validateUserBalance(userId, requiredAmount) {
        try {
            const response = await fetch(
                `${process.env.POSTGREST_URL}/account_balances?user_id=eq.${userId}`
            );

            if (!response.ok) {
                throw new Error(`PostgREST error: ${response.statusText}`);
            }

            const balances = await response.json();

            if (!balances || balances.length === 0) {
                throw new Error('User balance not found');
            }

            const currentBalance = parseFloat(balances[0].balance);

            if (currentBalance < requiredAmount) {
                throw new Error(`Insufficient balance. Required: ${requiredAmount}, Available: ${currentBalance}`);
            }

            return {
                currentBalance,
                sufficient: true
            };
        } catch (error) {
            console.error('Validate user balance error:', error);
            throw error;
        }
    }

    /**
     * 获取用户虚拟密钥列表
     */
    static async getUserVirtualKeys(userId) {
        try {
            const response = await fetch(
                `${process.env.POSTGREST_URL}/virtual_keys?user_id=eq.${userId}&is_active=eq.true`
            );

            if (!response.ok) {
                throw new Error(`PostgREST error: ${response.statusText}`);
            }

            return await response.json();
        } catch (error) {
            console.error('Get user virtual keys error:', error);
            throw error;
        }
    }

    /**
     * 创建用户虚拟密钥
     */
    static async createVirtualKey(userId, keyData) {
        try {
            const response = await fetch(
                `${process.env.POSTGREST_URL}/rpc/create_virtual_key`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        p_user_id: userId,
                        p_name: keyData.name,
                        p_description: keyData.description,
                        p_rate_limit_rpm: keyData.rate_limit_rpm || 1000,
                        p_rate_limit_tpm: keyData.rate_limit_tpm || 100000,
                        p_allowed_models: keyData.allowed_models || []
                    })
                }
            );

            if (!response.ok) {
                throw new Error(`PostgREST error: ${response.statusText}`);
            }

            const result = await response.json();
            return result;
        } catch (error) {
            console.error('Create virtual key error:', error);
            throw error;
        }
    }

    /**
     * 轮转虚拟密钥
     */
    static async rotateVirtualKey(oldVirtualKey, reason = 'security_rotation') {
        try {
            const response = await fetch(
                `${process.env.POSTGREST_URL}/rpc/rotate_virtual_key`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        p_old_virtual_key: oldVirtualKey,
                        p_reason: reason
                    })
                }
            );

            if (!response.ok) {
                throw new Error(`PostgREST error: ${response.statusText}`);
            }

            const result = await response.json();
            return result;
        } catch (error) {
            console.error('Rotate virtual key error:', error);
            throw error;
        }
    }

    /**
     * 停用虚拟密钥
     */
    static async deactivateVirtualKey(virtualKey, reason = 'user_request') {
        try {
            const response = await fetch(
                `${process.env.POSTGREST_URL}/virtual_keys?virtual_key=eq.${virtualKey}`,
                {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        is_active: false,
                        updated_at: new Date().toISOString()
                    })
                }
            );

            if (!response.ok) {
                throw new Error(`PostgREST error: ${response.statusText}`);
            }

            // 记录审计日志
            await this.logVirtualKeyAction('DEACTIVATE', virtualKey, { reason });

            return true;
        } catch (error) {
            console.error('Deactivate virtual key error:', error);
            throw error;
        }
    }

    /**
     * 获取用户使用统计
     */
    static async getUserUsageStats(userId, startDate, endDate) {
        try {
            let url = `${process.env.POSTGREST_URL}/usage_logs?user_id=eq.${userId}`;

            if (startDate) {
                url += `&created_at=gte.${startDate}`;
            }
            if (endDate) {
                url += `&created_at=lte.${endDate}`;
            }

            const response = await fetch(url);

            if (!response.ok) {
                throw new Error(`PostgREST error: ${response.statusText}`);
            }

            const usageLogs = await response.json();

            // 计算统计信息
            const stats = {
                total_requests: usageLogs.length,
                total_tokens: usageLogs.reduce((sum, log) => sum + (log.tokens_used || 0), 0),
                total_cost: usageLogs.reduce((sum, log) => sum + parseFloat(log.cost || 0), 0),
                by_provider: {},
                by_model: {}
            };

            // 按提供商分组
            usageLogs.forEach(log => {
                const provider = log.provider;
                const model = log.model;

                if (!stats.by_provider[provider]) {
                    stats.by_provider[provider] = {
                        requests: 0,
                        tokens: 0,
                        cost: 0
                    };
                }

                if (!stats.by_model[model]) {
                    stats.by_model[model] = {
                        requests: 0,
                        tokens: 0,
                        cost: 0
                    };
                }

                stats.by_provider[provider].requests++;
                stats.by_provider[provider].tokens += log.tokens_used || 0;
                stats.by_provider[provider].cost += parseFloat(log.cost || 0);

                stats.by_model[model].requests++;
                stats.by_model[model].tokens += log.tokens_used || 0;
                stats.by_model[model].cost += parseFloat(log.cost || 0);
            });

            return stats;
        } catch (error) {
            console.error('Get user usage stats error:', error);
            throw error;
        }
    }

    /**
     * 记录虚拟密钥操作审计日志
     */
    static async logVirtualKeyAction(action, virtualKey, details = {}) {
        try {
            const response = await fetch(
                `${process.env.POSTGREST_URL}/audit_logs`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        action: action,
                        target_type: 'virtual_key',
                        target_id: virtualKey,
                        detail: details,
                        created_at: new Date().toISOString()
                    })
                }
            );

            if (!response.ok) {
                console.warn('Failed to log audit action:', response.statusText);
            }
        } catch (error) {
            console.warn('Audit logging failed:', error);
        }
    }

    /**
     * 批量验证多个用户的访问权限
     */
    static async batchCheckUserAccess(userIds) {
        try {
            const results = {};

            for (const userId of userIds) {
                try {
                    const access = await this.checkUserAccess(userId);
                    results[userId] = {
                        success: true,
                        data: access
                    };
                } catch (error) {
                    results[userId] = {
                        success: false,
                        error: error.message
                    };
                }
            }

            return results;
        } catch (error) {
            console.error('Batch check user access error:', error);
            throw error;
        }
    }

    /**
     * 获取用户订阅信息
     */
    static async getUserSubscription(userId) {
        try {
            // 从用户配置中获取订阅信息
            const userContext = await this.getUserContext(userId);
            if (!userContext) {
                throw new Error('User not found');
            }

            return {
                user_id: userId,
                status: userContext.status,
                tier: userContext.status === 'active' ? 'premium' : 'standard',
                features: {
                    can_use_api: userContext.can_use_api,
                    can_generate_key: userContext.can_generate_key,
                    max_virtual_keys: userContext.status === 'active' ? 10 : 3,
                    rate_limits: {
                        rpm: userContext.status === 'active' ? 5000 : 1000,
                        tpm: userContext.status === 'active' ? 500000 : 100000
                    }
                }
            };
        } catch (error) {
            console.error('Get user subscription error:', error);
            throw error;
        }
    }
}

module.exports = { UserService };
