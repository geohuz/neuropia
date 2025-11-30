// neuropia_config_service/src/listeners/pgListener.js
const { Client } = require("pg");
const { ConfigManager } = require("../services/configManager");
const {
  PortkeyConfigGenerator,
} = require("../services/portkeyConfigGenerator");
const redisService = require("@shared/clients/redis");

class PGListener {
  constructor() {
    this.client = null;
    this.listeners = new Map();
  }

  async connect() {
    this.client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl:
        process.env.NODE_ENV === "production"
          ? { rejectUnauthorized: false }
          : false,
    });

    await this.client.connect();
    console.log("✅ PostgreSQL listener connected");

    // 🎯 监听新的统一配置更新频道
    await this.client.query("LISTEN config_updates");

    // 保持对旧频道的兼容
    await this.client.query("LISTEN config_update");
    await this.client.query("LISTEN virtual_key_update");

    this.client.on("notification", (msg) => {
      console.log(`📢 Received notification on channel: ${msg.channel}`);
      this.handleNotification(msg);
    });

    this.client.on("error", (err) => {
      console.error("❌ PostgreSQL listener error:", err);
    });
  }

  handleNotification(msg) {
    try {
      const payload = JSON.parse(msg.payload);

      switch (msg.channel) {
        case "config_updates":
          this.handleConfigUpdate(payload);
          break;
        case "config_update":
          ConfigManager.handleConfigUpdate(payload);
          break;
        case "virtual_key_update":
          ConfigManager.handleVirtualKeyUpdate(payload);
          break;
        default:
          console.log("Unknown notification channel:", msg.channel);
      }
    } catch (error) {
      console.error("❌ Error handling notification:", error);
    }
  }

  /**
   * 🆕 处理新的统一配置更新
   */
  async handleConfigUpdate(payload) {
    try {
      console.log("🔄 Handling config update:", payload);

      const { table, action } = payload;

      switch (table) {
        case "unified_config_store":
          await this.handleUnifiedConfigUpdate(payload);
          break;

        case "tier_feature_mappings":
          await this.handleTierFeatureUpdate(payload);
          break;

        case "inheritance_rules":
        case "config_levels":
          await this.handleStructuralUpdate(payload);
          break;

        case "config_types":
          await this.handleConfigTypeUpdate(payload);
          break;

        default:
          console.warn(`Unknown table in config update: ${table}`);
      }
    } catch (error) {
      console.error("❌ Failed to handle config update:", error);
    }
  }

  /**
   * 处理 unified_config_store 更新
   */
  async handleUnifiedConfigUpdate(payload) {
    const { virtual_key, scope_id } = payload;

    if (virtual_key) {
      // 🎯 清理具体虚拟密钥的缓存
      const pattern = `portkey_config:*:${virtual_key}:*`;
      const keys = await redisService.keys(pattern);
      if (keys.length > 0) {
        await redisService.del(...keys);
        console.log(
          `🧹 Cleared ${keys.length} caches for virtual_key: ${virtual_key}`,
        );
      }
    } else if (scope_id) {
      // 尝试使用 scope_id 作为 virtual_key
      const pattern = `portkey_config:*:${scope_id}:*`;
      const keys = await redisService.keys(pattern);
      if (keys.length > 0) {
        await redisService.del(...keys);
        console.log(
          `🧹 Cleared ${keys.length} caches for scope_id: ${scope_id}`,
        );
      }
    } else {
      // 🎯 保守策略：清理所有缓存
      await this.clearAllConfigCache();
    }
  }

  /**
   * 处理 tier_feature_mappings 更新
   */
  async handleTierFeatureUpdate(payload) {
    const { tier_name } = payload;

    if (tier_name) {
      // 🎯 清理该套餐的所有用户缓存
      const pattern = `portkey_config:*:*:${tier_name}:*`;
      const keys = await redisService.keys(pattern);
      if (keys.length > 0) {
        await redisService.del(...keys);
        console.log(`🍰 Cleared ${keys.length} caches for tier: ${tier_name}`);
      }
    } else {
      // 🎯 保守策略：清理所有缓存
      await this.clearAllConfigCache();
    }
  }

  /**
   * 处理结构变更（继承规则、层级）
   */
  async handleStructuralUpdate(payload) {
    // 🎯 结构变更影响所有配置，清理所有缓存
    await this.clearAllConfigCache();
    console.log("🌍 Structural change - cleared all config caches");
  }

  /**
   * 处理配置类型更新
   */
  async handleConfigTypeUpdate(payload) {
    const { type_name } = payload;

    if (type_name) {
      // 🎯 清理该配置类型的所有缓存
      const pattern = `config_resolution:${type_name}:*`;
      const keys = await redisService.keys(pattern);
      if (keys.length > 0) {
        await redisService.del(...keys);
        console.log(
          `📝 Cleared ${keys.length} caches for config_type: ${type_name}`,
        );
      }
    } else {
      // 🎯 保守策略：清理所有配置解析缓存
      const pattern = `config_resolution:*`;
      const keys = await redisService.keys(pattern);
      if (keys.length > 0) {
        await redisService.del(...keys);
        console.log(`📝 Cleared all config resolution caches`);
      }
    }
  }

  /**
   * 清理所有配置缓存
   */
  async clearAllConfigCache() {
    const portkeyKeys = await redisService.keys("portkey_config:*");
    const configResolutionKeys = await redisService.keys("config_resolution:*");

    const allKeys = [...portkeyKeys, ...configResolutionKeys];

    if (allKeys.length > 0) {
      await redisService.del(...allKeys);
      console.log(`🌍 Cleared all ${allKeys.length} config caches`);
    }
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    const callbacks = this.listeners.get(event) || [];
    callbacks.forEach((callback) => {
      try {
        callback(data);
      } catch (error) {
        console.error(`Error in event listener for ${event}:`, error);
      }
    });
  }

  async disconnect() {
    if (this.client) {
      await this.client.end();
      console.log("PostgreSQL listener disconnected");
    }
  }
}

module.exports = new PGListener();
