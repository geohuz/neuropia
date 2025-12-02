// src/services/pricingCacheManager.js
const { Client } = require('pg');
const RedisService = require('@shared/clients/redis_op');
const postgrest = require('../clients/postgrest');
const CACHE_KEYS = require('../constants/cacheKeys');

const DEFAULT_TTL = 300; // 秒

class PricingCacheManager {
  constructor() {
    this.pgClient = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    // pgClient 用于监听 pg_notify
    this.pgClient = new Client({ connectionString: process.env.DATABASE_URL });
    await this.pgClient.connect();

    // 监听价格表变化通知
    await this.pgClient.query('LISTEN customer_type_rate_update');

    this.pgClient.on('notification', async (msg) => {
      try {
        if (msg.channel === 'customer_type_rate_update') {
          const ctId = msg.payload; // pg_notify 发送的是 customer_type_id
          await this.handlePriceChange(ctId);
        }
      } catch (err) {
        console.error('❌ Error handling pg notification:', err);
      }
    });

    this.initialized = true;
    console.log('✅ pricingCacheManager initialized with pg_notify listening');
  }

  /**
   * 处理价格表变动
   */
  async handlePriceChange(ctId) {
    console.log('📢 Detected price change for customer_type_id:', ctId);

    // 1️⃣ 失效 customer_type 缓存
    await this.invalidate(ctId);

    // 2️⃣ 失效依赖该 customer_type 的 virtual_key 缓存
    await this._invalidateVirtualKeysByCustomerType(ctId);
  }

  /**
   * 内部方法：根据 customer_type 查找依赖的 virtual_key 并失效缓存
   */
   async _invalidateVirtualKeysByCustomerType(ctId) {
     try {
       const { data: vks, error } = await postgrest
         .from('virtual_keys_by_customer_type')
         .select('virtual_key')
         .eq('customer_type_id', ctId);

       if (error) {
         console.error('❌ Failed to get virtual_keys for customer_type_id:', ctId, error);
         return;
       }

       if (!Array.isArray(vks) || vks.length === 0) {
         console.log(`ℹ️ No virtual_keys found for customer_type_id: ${ctId}`);
         return;
       }

       for (const vkRow of vks) {
         const vk = vkRow.virtual_key;
         await invalidateVirtualKeyPricing(vk);
         console.log(`🧹 Invalidated virtual_key pricing cache: ${vk}`);
       }
     } catch (err) {
       console.error('❌ Unexpected error in _invalidateVirtualKeysByCustomerType:', ctId, err);
     }
   }


  /**
   * 获取 customer_type 价格表
   */
  async get(customerTypeId, ttl = DEFAULT_TTL) {
    const cacheKey = CACHE_KEYS.CUSTOMER_TYPE_PRICING(customerTypeId);

    const cached = await RedisService.kv.get(cacheKey);
    if (cached) {
      console.log('📦 价格缓存命中:', customerTypeId);
      return JSON.parse(cached);
    }

    // 查询走 PostgREST RPC
    const { data, error } = await postgrest.rpc('get_customer_type_pricing', {
      p_customer_type_id: customerTypeId
    });
    if (error) throw error;

    await RedisService.kv.setex(cacheKey, ttl, JSON.stringify(data));
    console.log('💾 价格缓存写入:', customerTypeId);

    return data;
  }

  async refresh(customerTypeId, ttl = DEFAULT_TTL) {
    console.log('🔄 刷新价格缓存:', customerTypeId);
    return this.get(customerTypeId, ttl);
  }

  async invalidate(customerTypeId) {
    const cacheKey = CACHE_KEYS.CUSTOMER_TYPE_PRICING(customerTypeId);
    await RedisService.kv.del(cacheKey);
    console.log('❌ 价格缓存失效:', customerTypeId);
  }

  async shutdown() {
    if (this.pgClient) {
      await this.pgClient.end();
      console.log('✅ pricingCacheManager PostgreSQL connection closed');
    }
  }
}

// ------------------------------
// 获取 virtual_key 对应价格表（外部调用）
async function getVirtualKeyPricing(vk, fetchFromDb) {
  const key = CACHE_KEYS.VIRTUAL_KEY_PRICING(vk);

  const cached = await RedisService.kv.get(key);
  if (cached) return JSON.parse(cached);

  const pricingJson = await fetchFromDb(vk);

  await RedisService.kv.setex(key, DEFAULT_TTL, JSON.stringify(pricingJson));
  return pricingJson;
}

// ------------------------------
// 失效 virtual_key 缓存（外部调用）
async function invalidateVirtualKeyPricing(vk) {
  await RedisService.kv.del(CACHE_KEYS.VIRTUAL_KEY_PRICING(vk));
}

// ------------------------------
// 获取 customer_type 价格表（外部调用）
async function getCustomerTypePricing(ctId, fetchFromDb) {
  const key = CACHE_KEYS.CUSTOMER_TYPE_PRICING(ctId);

  const cached = await RedisService.kv.get(key);
  if (cached) return JSON.parse(cached);

  const pricingJson = await fetchFromDb(ctId);

  await RedisService.kv.setex(key, DEFAULT_TTL, JSON.stringify(pricingJson));
  return pricingJson;
}

// ------------------------------
// 失效 customer_type 缓存（外部调用）
async function invalidateCustomerTypePricing(ctId) {
  await RedisService.kv.del(CACHE_KEYS.CUSTOMER_TYPE_PRICING(ctId));
}

// 单例导出
const pricingCacheManager = new PricingCacheManager();
module.exports = pricingCacheManager;
module.exports.getVirtualKeyPricing = getVirtualKeyPricing;
module.exports.invalidateVirtualKeyPricing = invalidateVirtualKeyPricing;
module.exports.getCustomerTypePricing = getCustomerTypePricing;
module.exports.invalidateCustomerTypePricing = invalidateCustomerTypePricing;
