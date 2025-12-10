// test-gateway-fix.js
require("module-alias/register");
const gatewayControlService = require("./services/gatewayControlService");

async function testFix() {
  console.log("=== 测试网关控制服务修复 ===\n");

  // 测试1：租户限额
  console.log("1. 测试租户限额查询:");
  const tenantLimits = await gatewayControlService.getLimits({
    account_type: "tenant",
    account_id: "9d865a1b-2c8b-444e-9172-39e2c3517292",
    customer_type_id: null,
  });
  console.log("租户限额:", tenantLimits);
  console.log("预期: { soft_limit: 5000, hard_limit: 1000 }");
  console.log(
    "结果:",
    tenantLimits.soft_limit === 5000 && tenantLimits.hard_limit === 1000
      ? "✅ 通过"
      : "❌ 失败",
  );

  // 测试2：客户类型配置（如果有的话）
  console.log("\n2. 测试客户类型限额查询:");
  try {
    const customerTypeLimits = await gatewayControlService.getLimits({
      account_type: "user",
      account_id: "test-customer-user",
      customer_type_id: "eb948fd1-b8da-46c7-aa51-92eb296970c8",
    });
    console.log("客户类型限额:", customerTypeLimits);
    console.log("预期: { soft_limit: 500, hard_limit: 250 }");
  } catch (error) {
    console.log("客户类型测试跳过:", error.message);
  }

  // 测试3：全局限额
  console.log("\n3. 测试全局限额查询:");
  const globalLimits = await gatewayControlService.getLimits({
    account_type: "user",
    account_id: "test-user",
    customer_type_id: null,
  });
  console.log("全局限额:", globalLimits);
  console.log("预期: { soft_limit: 100, hard_limit: 50 }");
  console.log(
    "结果:",
    globalLimits.soft_limit === 100 && globalLimits.hard_limit === 50
      ? "✅ 通过"
      : "❌ 失败",
  );

  // 测试4：缓存测试（第二次查询应该命中缓存）
  console.log("\n4. 测试缓存命中:");
  const cachedLimits = await gatewayControlService.getLimits({
    account_type: "tenant",
    account_id: "9d865a1b-2c8b-444e-9172-39e2c3517292",
    customer_type_id: null,
  });
  console.log("缓存查询结果:", cachedLimits);
  console.log(
    "应与第一次结果相同:",
    JSON.stringify(cachedLimits) === JSON.stringify(tenantLimits)
      ? "✅ 通过"
      : "❌ 失败",
  );

  // 测试5：缓存键格式
  console.log("\n5. 验证缓存键格式:");
  const softKey = gatewayControlService._buildLimitCacheKey(
    "tenant",
    "test-tenant",
    null,
    "soft_limit",
  );
  console.log("Soft Limit Key:", softKey);
  console.log(
    "是否符合CACHE_KEYS格式:",
    softKey === "gateway:control:tenant:test-tenant:soft_limit"
      ? "✅ 通过"
      : "❌ 失败",
  );

  console.log("\n=== 测试完成 ===");
}

testFix().catch(console.error);
