require("dotenv").config();
require("module-alias/register");
const { Client } = require("pg");
const BalanceService = require("./services/BalanceService");
const RedisService = require("@shared/clients/redis_op");

async function testNotifyCache() {
  console.log("🚀 开始 pg_notify → Redis 缓存失效验证");

  // 1️⃣ 初始化 Redis & BalanceService
  await RedisService.connect();
  await BalanceService.initialize();

  const vk = "vk_908782e38b24598fb24da818eea36ef2";

  // 2️⃣ 查询缓存初始值
  const account = await BalanceService.resolveBillingAccount(vk);
  const balanceKey = `balance:${account.type}:${account.id}`;
  const billingKey = `billing_account:${vk}`;

  let balanceCache = await RedisService.kv.get(balanceKey);
  let billingCache = await RedisService.kv.get(billingKey);

  console.log("初始 balance 缓存:", balanceCache);
  console.log("初始 billing_account 缓存:", billingCache);

  // 3️⃣ 模拟数据库触发 pg_notify
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  const payload = {
    account_id: account.id,
    account_type: account.type,
  };

  console.log("等待 1 秒让 pg_notify 通知 Node.js...");
  await new Promise((r) => setTimeout(r, 1000));

  await pg.query(`SELECT pg_notify('account_balance_updated', $1);`, [
    JSON.stringify(payload),
  ]);

  // 4️⃣ 等待 pg_notify 处理
  await new Promise((r) => setTimeout(r, 1000));

  // 5️⃣ 再次检查缓存
  balanceCache = await RedisService.kv.get(balanceKey);
  billingCache = await RedisService.kv.get(billingKey);

  console.log("更新后 balance 缓存:", balanceCache);
  console.log("更新后 billing_account 缓存:", billingCache);

  if (balanceCache === null && billingCache === null) {
    console.log(
      "✅ 测试完成，如果 balance 和 billing_account 缓存为 null，说明通知 + 缓存失效正确",
    );
  } else {
    console.warn("⚠️ 测试异常，缓存没有被清除");
  }

  await pg.end();
}

testNotifyCache().catch((err) => {
  console.error("❌ 测试失败:", err);
  process.exit(1);
});
