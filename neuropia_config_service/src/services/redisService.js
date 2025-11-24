// src/services/redisService.js
const redis = require('redis');

class RedisService {
    constructor() {
        this.client = null;
    }

    async connect() {
        this.client = redis.createClient({
            url: process.env.REDIS_URL || 'redis://localhost:6379'
        });

        this.client.on('error', (err) => console.error('Redis Client Error', err));
        await this.client.connect();
        console.log('Connected to Redis');
    }

    async cacheVirtualKey(virtualKey, config) {
        const key = `virtual_key:${virtualKey}`;
        await this.client.set(key, JSON.stringify(config), {
            EX: 3600 // 1小时过期
        });
    }

    async getVirtualKey(virtualKey) {
        const key = `virtual_key:${virtualKey}`;
        const data = await this.client.get(key);
        return data ? JSON.parse(data) : null;
    }

    async cachePortkeyConfig(key, config) {
        await this.client.set(key, JSON.stringify(config), {
            EX: 7200 // 2小时过期
        });
    }

    async getPortkeyConfig(key) {
        const data = await this.client.get(key);
        return data ? JSON.parse(data) : null;
    }

    async cacheProviderRates(rates) {
        await this.client.set('provider_rates', JSON.stringify(rates), {
            EX: 3600 // 1小时过期
        });
    }

    async getProviderRates() {
        const data = await this.client.get('provider_rates');
        return data ? JSON.parse(data) : [];
    }

    async incrementVirtualKeyUsage(virtualKey, tokensUsed = 0) {
        const key = `usage:${virtualKey}`;
        await this.client.multi()
            .hIncrBy(key, 'request_count', 1)
            .hIncrBy(key, 'token_count', tokensUsed)
            .hSet(key, 'last_used', new Date().toISOString())
            .expire(key, 86400) // 24小时过期
            .exec();
    }
}

module.exports = new RedisService();
