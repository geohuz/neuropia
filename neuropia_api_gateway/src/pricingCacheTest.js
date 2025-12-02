// test/pricingCacheTest.js
require("dotenv").config();
require('module-alias/register');
const pricingCacheManager = require('./services/pricingCacheManager');
const RedisService = require('@shared/clients/redis_op');
const postgrest = require('./clients/postgrest');

async function runTest() {
  // 初始化 cache manager（监听 pg_notify）
  await pricingCacheManager.initialize();

  // ----------------------
  // 1️⃣ 测试获取 customer_type_id 价格表
  // ----------------------
  const customerTypeId = 'eb948fd1-b8da-46c7-aa51-92eb296970c8'; // sample data
  console.log('--- 获取 customer_type_id 价格表 ---');
  const pricing1 = await pricingCacheManager.get(customerTypeId, 60);
  console.log('pricing1:', JSON.stringify(pricing1, null, 2));

  // ----------------------
  // 2️⃣ 再次获取，应该命中 Redis
  // ----------------------
  console.log('--- 再次获取 customer_type_id 价格表（应命中 Redis） ---');
  const pricing2 = await pricingCacheManager.get(customerTypeId, 60);
  console.log('pricing2:', JSON.stringify(pricing2, null, 2));

  // ----------------------
  // 3️⃣ 模拟 pg_notify 变更，失效缓存
  // ----------------------
  console.log('--- 模拟价格变更通知 ---');
  await pricingCacheManager.handlePriceChange(customerTypeId) ;

  // ----------------------
  // 4️⃣ 再次获取，应重新 RPC 查询
  // ----------------------
  console.log('--- 重新获取 customer_type_id 价格表（应重新 RPC 查询） ---');
  const pricing3 = await pricingCacheManager.get(customerTypeId, 60);
  console.log('pricing3:', JSON.stringify(pricing3, null, 2));

  // ----------------------
  // 5️⃣ 测试 virtual_key 获取价格表
  // ----------------------
  const virtualKey = 'vk_908782e38b24598fb24da818eea36ef2';
  console.log('--- 获取 virtual_key 价格表 ---');
  const vkPricing = await pricingCacheManager.getVirtualKeyPricing(
    virtualKey,
    async (vk) => {
      // 使用 PostgREST RPC
      const { data, error } = await postgrest.rpc('get_virtualkey_pricing', { p_virtual_key: vk});
      if (error) throw error;
      return data;
    }
  );
  console.log('vkPricing:', JSON.stringify(vkPricing, null, 2));
}

runTest().catch(console.error);
