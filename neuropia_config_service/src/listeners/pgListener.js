// src/listeners/pgListener.js
const { Client } = require('pg');
const { ConfigManager } = require('../services/configManager');

class PGListener {
    constructor() {
        this.client = null;
    }

    async connect() {
        this.client = new Client({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
        });

        await this.client.connect();
        console.log('Connected to PostgreSQL for listening');

        // 监听配置更新通知
        await this.client.query('LISTEN config_update');
        await this.client.query('LISTEN virtual_key_update');

        this.client.on('notification', (msg) => {
            this.handleNotification(msg);
        });
    }

    handleNotification(msg) {
        try {
            const payload = JSON.parse(msg.payload);

            switch(msg.channel) {
                case 'config_update':
                    ConfigManager.handleConfigUpdate(payload.configId);
                    break;
                case 'virtual_key_update':
                    // 处理虚拟密钥更新
                    break;
                default:
                    console.log('Unknown notification channel:', msg.channel);
            }
        } catch (error) {
            console.error('Error handling notification:', error);
        }
    }
}

module.exports = new PGListener();
