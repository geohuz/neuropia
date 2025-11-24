// neuropia_api_gateway/src/services/redisService.js
const redis = require('redis');

class RedisService {
    constructor() {
        this.client = null;
    }

    async connect() {
        if (this.client) return;

        this.client = redis.createClient({
            url: process.env.REDIS_URL || 'redis://localhost:6379'
        });

        this.client.on('error', (err) => console.error('Redis Client Error', err));
        await this.client.connect();
        console.log('API Gateway connected to Redis');
    }

    // API Gateway 需要的方法
    async getVirtualKey(virtualKey) {
        const key = `virtual_key:${virtualKey}`;
        const data = await this.client.get(key);
        return data ? JSON.parse(data) : null;
    }

    async getProviderRates() {
        const data = await this.client.get('provider_rates');
        return data ? JSON.parse(data) : [];
    }

    async getProviderModel(modelName) {
        const models = await this.client.get('provider_models');
        const modelMap = models ? JSON.parse(models) : {};
        return modelMap[modelName] || null;
    }

    async incrementVirtualKeyUsage(virtualKey, tokensUsed = 0) {
        const key = `usage:${virtualKey}`;
        await this.client.multi()
            .hIncrBy(key, 'request_count', 1)
            .hIncrBy(key, 'token_count', tokensUsed)
            .hSet(key, 'last_used', new Date().toISOString())
            .expire(key, 86400)
            .exec();
    }

    async healthCheck() {
        try {
            await this.client.ping();
            return true;
        } catch (error) {
            return false;
        }
    }
}

module.exports = new RedisService();
