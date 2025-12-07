const { Client } = require("@shared/clients/pg");
const RedisService = require("@shared/clients/redis_op");
const CACHE_KEYS = require("../constants/cacheKeys");
const pgNotifyListener = require("../listeners/pgNotifyListener");
const ALL_CHANNELS = require("../constants/pgNotifyChannels");
const logger = require("@shared/utils/logger"); // 引入 logger

class ConfigCacheManager {
  constructor() {
    this.pgClient = null;
    this.initialized = false;
    this.logger = logger; // 保存 logger 实例
  }

  async initialize() {
    if (this.initialized) return;

    pgNotifyListener.eventBus.on(ALL_CHANNELS.NODE_CHANGED, async (payload) => {
      await this.handleNodeChange(payload);
    });

    pgNotifyListener.eventBus.on(
      ALL_CHANNELS.VIRTUAL_KEY_CONFIG,
      async (payload) => {
        await this.handleVirtualKeyChange(payload);
      },
    );

    this.initialized = true;
    this.logger.info(
      "✅ configCacheManager initialized with pg_notify listening",
    );
  }

  async handleNotification(msg) {
    this.logger.info(
      `📢 Received notification: ${msg.channel} - ${msg.payload}`,
    );

    try {
      switch (msg.channel) {
        case "node_changed":
          await this.handleNodeChange(msg.payload);
          break;
        case "virtual_key_config_changed":
          await this.handleVirtualKeyChange(msg.payload);
          break;
      }
    } catch (error) {
      logger.error("❌ Error handling notification", {
        channel: msg.channel,
        payload: msg.payload,
        error: error.message,
        stack: error.stack,
        code: error.code,
        name: error.name,
      });
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
        this.logger.info(`🧹 Cleared vk_config for: ${vkId} (node change)`);
      }
    }
  }

  /**
   * 处理 virtual_key 变更
   */
  async handleVirtualKeyChange(virtualKey) {
    await RedisService.kv.del(CACHE_KEYS.VIRTUAL_KEY_CONFIG(virtualKey));
    this.logger.info(`🧹 Cleared vk_config for: ${virtualKey}`);
  }

  async shutdown() {
    if (this.pgClient) {
      await this.pgClient.end();
      this.logger.info("✅ CacheManager PostgreSQL connection closed");
    }
  }
}

const configCacheManager = new ConfigCacheManager();
module.exports = configCacheManager;
