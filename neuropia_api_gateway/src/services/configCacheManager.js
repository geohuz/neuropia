// neuropia_api_gateway/src/services/cacheManager.js
const { Client } = require('pg');
const RedisService = require('@shared/clients/redis_op');
const CACHE_KEYS = require('../constants/cacheKeys');

class configCacheManager {
    constructor() {
        this.pgClient = null;
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return;

        this.pgClient = new Client({
            connectionString: process.env.DATABASE_URL
        });

        await this.pgClient.connect();

        // 监听配置变更通知
        await this.pgClient.query('LISTEN node_changed');
        await this.pgClient.query('LISTEN virtual_key_config_changed');

        this.pgClient.on('notification', this.handleNotification.bind(this));

        this.initialized = true;
        console.log('✅ CacheManager initialized with pg_notify listening');
    }

    async handleNotification(msg) {
        console.log(`📢 Received notification: ${msg.channel} - ${msg.payload}`);

        try {
            switch (msg.channel) {
                case 'node_changed':
                    await this.handleNodeChange(msg.payload);
                    break;
                case 'virtual_key_config_changed':
                    await this.handleVirtualKeyChange(msg.payload);
                    break;
            }
        } catch (error) {
            console.error('❌ Error handling notification:', error);
        }
    }

    /**
     * 处理节点变更
     */
    async handleNodeChange(nodeId) {
        const cacheKey = CACHE_KEYS.NODE_VK_MAPPING(nodeId);
        const cached = await RedisService.kv.get(cacheKey);

        if (cached) {
            const vkIds = JSON.parse(cached);
            for (const vkId of vkIds) {
                await RedisService.kv.del(CACHE_KEYS.VIRTUAL_KEY_CONFIG(vkId));
                console.log(`🧹 Cleared vk_config for: ${vkId} (node change)`);
            }
        }
    }

    /**
     * 处理 virtual_key 变更
     */
    async handleVirtualKeyChange(virtualKey) {
        await RedisService.kv.del(CACHE_KEYS.VIRTUAL_KEY_CONFIG(virtualKey));
        console.log(`🧹 Cleared vk_config for: ${virtualKey}`);
    }

    async shutdown() {
        if (this.pgClient) {
            await this.pgClient.end();
            console.log('✅ CacheManager PostgreSQL connection closed');
        }
    }
}

module.exports = new configCacheManager();
