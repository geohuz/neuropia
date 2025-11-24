// src/services/configManager.js
const { RedisService } = require('./redisService');
const postgrestClient = require('../clients/postgrest');

class ConfigManager {
    static async loadAllConfigs() {
        try {
            // 加载虚拟密钥
            const virtualKeys = await postgrestClient.get('/virtual_key_details');
            for (const vk of virtualKeys) {
                await RedisService.cacheVirtualKey(vk.virtual_key, vk);
            }

            // 加载 Portkey 配置
            const configs = await postgrestClient.get('/active_portkey_configs');
            for (const config of configs) {
                const cacheKey = `portkey_config:${config.id}`;
                await RedisService.cachePortkeyConfig(cacheKey, config);
            }

            // 加载提供商费率
            const rates = await postgrestClient.get('/current_provider_rates');
            await RedisService.cacheProviderRates(rates);

            console.log('All configurations loaded to Redis');
        } catch (error) {
            console.error('Failed to load configurations:', error);
            throw error;
        }
    }

    static async getPortkeyConfigForUser(userId) {
        try {
            // 从数据库获取用户配置
            const response = await postgrestClient.post('/rpc/get_active_portkey_config', {
                p_tenant_id: null, // 从用户上下文获取
                p_user_id: userId
            });

            return response.data;
        } catch (error) {
            console.error('Failed to get portkey config:', error);
            throw error;
        }
    }

    static async handleConfigUpdate(configId) {
        try {
            // 重新加载特定配置
            const config = await postgrestClient.get(`/portkey_configs_view?id=eq.${configId}`);
            if (config && config.length > 0) {
                const cacheKey = `portkey_config:${configId}`;
                await RedisService.cachePortkeyConfig(cacheKey, config[0]);
                console.log(`Config ${configId} updated in Redis`);
            }
        } catch (error) {
            console.error('Failed to update config:', error);
        }
    }
}

module.exports = { ConfigManager };
