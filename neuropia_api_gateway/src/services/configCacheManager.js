const RedisService = require("@shared/clients/redis_op");
const CACHE_KEYS = require("../constants/cacheKeys");
const pgNotifyListener = require("../listeners/pgNotifyListener");
const ALL_CHANNELS = require("../constants/pgNotifyChannels");
const logger = require("@shared/utils/logger");

class ConfigCacheManager {
  constructor() {
    this.initialized = false;
    this.logger = logger;
  }

  async initialize() {
    if (this.initialized) return;

    pgNotifyListener.eventBus.on(ALL_CHANNELS.NODE_CHANGED, async (payload) => {
      await this.handleNodeChange(payload);
    });

    pgNotifyListener.eventBus.on(
      ALL_CHANNELS.VIRTUAL_KEY_CONFIG_CHANGED,
      async (payload) => {
        await this.handleVirtualKeyChange(payload);
      },
    );

    this.initialized = true;
    this.logger.info(
      "✅ configCacheManager initialized with pg_notify listening",
    );
  }

  async handleNodeChange(payload) {
    // payload 应该是 { node_id, virtual_key_ids, updated_at }
    const nodeId = payload.node_id || payload; // 兼容两种格式
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

  async handleVirtualKeyChange(payload) {
    // payload 可能是字符串ID或对象 { virtual_key_id, ... }
    const virtualKey =
      typeof payload === "string" ? payload : payload.virtual_key_id;
    await RedisService.kv.del(CACHE_KEYS.VIRTUAL_KEY_CONFIG(virtualKey));
    this.logger.info(`🧹 Cleared vk_config for: ${virtualKey}`);
  }

  async shutdown() {
    // 清理资源（如果需要）
  }
}

const configCacheManager = new ConfigCacheManager();
module.exports = configCacheManager;
