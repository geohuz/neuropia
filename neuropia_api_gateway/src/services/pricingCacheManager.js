// src/services/pricingCacheManager.js
const RedisService = require("@shared/clients/redis_op");
const postgrest = require("@shared/clients/postgrest");
const pgNotifyListener = require("../listeners/pgNotifyListener");
const ALL_CHANNELS = require("../constants/pgNotifyChannels");
const CACHE_KEYS = require("../constants/cacheKeys");

const TTL = CACHE_KEYS.TTL.VIRTUAL_KEY_PRICING;
console.log("ALL_CHA", ALL_CHANNELS);

class PricingCacheManager {
  constructor() {
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    console.log(
      "🔧 PricingCacheManager 初始化，监听频道:",
      ALL_CHANNELS.CUSTOMER_TYPE_RATE_UPDATE,
    );
    console.log("🔧 pgNotifyListener.eventBus:", !!pgNotifyListener.eventBus);
    console.log(
      "🔧 pgNotifyListener.eventBus.on 方法:",
      typeof pgNotifyListener.eventBus.on,
    );

    // 注册价格变化处理器（app.js已确保pgNotifyListener.start()）
    pgNotifyListener.eventBus.on(
      ALL_CHANNELS.CUSTOMER_TYPE_RATE_UPDATE,
      async (payload) => {
        console.log("🔔 [Price] 收到通知事件:", {
          channel: ALL_CHANNELS.CUSTOMER_TYPE_RATE_UPDATE,
          payload: payload,
          payloadType: typeof payload,
          timestamp: new Date().toISOString(),
        });
        await this.handlePriceChange(payload);
      },
    );

    this.initialized = true;
    console.log("✅ pricingCacheManager initialized");
  }

  /**
   * 处理价格表变动
   */
  async handlePriceChange(payload) {
    const ctId = payload.customer_type_id;
    console.log("📢 Detected price change for customer_type_id:", ctId);

    // 1. 失效 customer_type 缓存
    await this.invalidateCustomerTypePricing(ctId);

    // 2. 失效依赖的 virtual_key 价格缓存
    const { data: vks } = await postgrest
      .from("virtual_keys_by_customer_type")
      .select("virtual_key")
      .eq("customer_type_id", ctId);

    if (Array.isArray(vks)) {
      for (const { virtual_key } of vks) {
        await this.invalidateVirtualKeyPricing(virtual_key);
      }
    }
  }

  /**
   * 获取 virtual_key 的价格配置（封装数据库查询）
   */
  async getVirtualKeyPricing(virtualKey, ttl = TTL) {
    const cacheKey = CACHE_KEYS.VIRTUAL_KEY_PRICING(virtualKey);

    // 1. 检查缓存
    const cached = await RedisService.kv.get(cacheKey);
    if (cached) {
      console.log("📦 Virtual key 价格缓存命中:", virtualKey);
      return JSON.parse(cached);
    }

    // 2. 查询数据库（使用 pg 函数）
    const { data, error } = await postgrest.rpc("get_virtualkey_pricing", {
      p_virtual_key: virtualKey,
    });

    if (error) {
      console.error(
        "❌ Failed to fetch virtual key pricing:",
        virtualKey,
        error,
      );
      throw new Error(`PRICING_FETCH_FAILED: ${error.message}`);
    }

    if (!data) {
      throw new Error(`PRICING_NOT_FOUND for virtual key: ${virtualKey}`);
    }

    // 3. 写入缓存
    await RedisService.kv.setex(cacheKey, ttl, JSON.stringify(data));
    console.log("💾 Virtual key 价格缓存写入:", virtualKey);

    return data;
  }

  /**
   * 获取 customer_type 的价格配置（封装数据库查询）
   */
  async getCustomerTypePricing(customerTypeId, ttl = TTL) {
    const cacheKey = CACHE_KEYS.CUSTOMER_TYPE_PRICING(customerTypeId);

    // 1. 检查缓存
    const cached = await RedisService.kv.get(cacheKey);
    if (cached) {
      console.log("📦 Customer type 价格缓存命中:", customerTypeId);
      return JSON.parse(cached);
    }

    // 2. 查询数据库（使用 PostgREST RPC）
    const { data, error } = await postgrest.rpc("get_customer_type_pricing", {
      p_customer_type_id: customerTypeId,
    });

    if (error) {
      console.error(
        "❌ Failed to fetch customer type pricing:",
        customerTypeId,
        error,
      );
      throw new Error(`CUSTOMER_TYPE_PRICING_FETCH_FAILED: ${error.message}`);
    }

    if (!data) {
      throw new Error(`PRICING_NOT_FOUND for customer type: ${customerTypeId}`);
    }

    // 3. 写入缓存
    await RedisService.kv.setex(cacheKey, ttl, JSON.stringify(data));
    console.log("💾 Customer type 价格缓存写入:", customerTypeId);

    return data;
  }

  /**
   * 根据 provider 和 model 获取特定价格
   */
  async getProviderModelPrice(virtualKey, provider, model) {
    const pricingData = await this.getVirtualKeyPricing(virtualKey);

    if (!pricingData || !pricingData.prices) {
      throw new Error("Invalid pricing data");
    }

    const key = `${provider}:${model}`;
    const priceInfo = pricingData.prices[key];

    if (!priceInfo) {
      // 如果找不到特定模型，尝试找 provider 的默认价格
      const fallbackKey = Object.keys(pricingData.prices).find((k) =>
        k.startsWith(`${provider}:`),
      );
      if (fallbackKey) {
        console.log(
          `⚠️ Using fallback price for ${provider}:${model} -> ${fallbackKey}`,
        );
        return pricingData.prices[fallbackKey];
      }
      throw new Error(`Price not found for ${provider}:${model}`);
    }

    return priceInfo;
  }

  /**
   * 刷新缓存
   */
  async refreshVirtualKeyPricing(virtualKey, ttl = TTL) {
    console.log("🔄 刷新 virtual key 价格缓存:", virtualKey);
    await this.invalidateVirtualKeyPricing(virtualKey);
    return this.getVirtualKeyPricing(virtualKey, ttl);
  }

  async refreshCustomerTypePricing(customerTypeId, ttl = TTL) {
    console.log("🔄 刷新 customer type 价格缓存:", customerTypeId);
    await this.invalidateCustomerTypePricing(customerTypeId);
    return this.getCustomerTypePricing(customerTypeId, ttl);
  }

  /**
   * 失效缓存
   */
  async invalidateVirtualKeyPricing(virtualKey) {
    const cacheKey = CACHE_KEYS.VIRTUAL_KEY_PRICING(virtualKey);
    await RedisService.kv.del(cacheKey);

    // ✅ 同时失效 BILLING_CONTEXT
    const contextKey = CACHE_KEYS.BILLING_CONTEXT(virtualKey);
    await RedisService.kv.del(contextKey);

    console.log(`❌ 失效价格和相关缓存: ${virtualKey}`);
  }

  async invalidateCustomerTypePricing(customerTypeId) {
    const cacheKey = CACHE_KEYS.CUSTOMER_TYPE_PRICING(customerTypeId);
    await RedisService.kv.del(cacheKey);
    console.log("❌ Customer type 价格缓存失效:", customerTypeId);
  }

  async shutdown() {
    if (this.pgClient) {
      await this.pgClient.end();
      console.log("✅ pricingCacheManager PostgreSQL connection closed");
    }
  }
}

// 单例导出
const pricingCacheManager = new PricingCacheManager();
module.exports = pricingCacheManager;
