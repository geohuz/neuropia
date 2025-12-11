// test/gateway-config-check.js
require("module-alias/register");
const gatewayControlService = require("./services/gatewayControlService");

async function checkGatewayConfig() {
  console.log("=== Gateway配置验证 ===\n");

  // 确保服务已初始化
  if (!gatewayControlService.config) {
    await gatewayControlService.initialize();
  }

  console.log("1. 当前配置状态:");
  const snapshot = gatewayControlService.getConfigSnapshot();
  console.log("- 是否有配置:", snapshot.has_config ? "✅ 有" : "❌ 无");
  console.log("- 缓存键:", snapshot.cache_key);
  console.log("- 告警冷却数量:", snapshot.alert_cooldown_size);

  if (gatewayControlService.config) {
    console.log("2. 配置树详情:");
    console.log("- 全局TPM:", gatewayControlService.config.global?.tpm?.value);
    console.log("- 全局RPM:", gatewayControlService.config.global?.rpm?.value); // 新增
    console.log(
      "- 全局软限制:",
      gatewayControlService.config.global?.soft_limit?.value,
    );
    console.log(
      "- 全局硬限制:",
      gatewayControlService.config.global?.hard_limit?.value,
    );

    const tenantId = "9d865a1b-2c8b-444e-9172-39e2c3517292";
    const customerTypeId = "eb948fd1-b8da-46c7-aa51-92eb296970c8"; // ✅ 添加这行
    const tenant = gatewayControlService.config.tenants?.[tenantId];

    if (tenant) {
      console.log(`\n3. 租户 ${tenantId} 配置:`);
      console.log("- 租户全局TPM:", tenant.global?.tpm?.value);
      console.log("- 租户全局RPM:", tenant.global?.rpm?.value); // 新增
      console.log("- 租户软限制:", tenant.global?.soft_limit?.value);
      console.log("- 租户硬限制:", tenant.global?.hard_limit?.value);

      if (tenant.providers?.openai) {
        console.log(
          "- openai TPM:",
          tenant.providers.openai.global?.tpm?.value,
        );
        console.log(
          "- openai RPM:",
          tenant.providers.openai.global?.rpm?.value,
        ); // 新增
        console.log(
          "- gpt-4 TPM:",
          tenant.providers.openai.models?.["gpt-4"]?.tpm?.value,
        );
      }
    }

    // 配置查找测试中添加RPM
    console.log("\n4. 配置查找测试:");
    const userConfig1 = gatewayControlService.getConfig(
      { tenant_id: tenantId },
      "openai",
      "gpt-4",
    );
    console.log("场景1 - 租户+openai+gpt-4:");
    console.log("  TPM:", userConfig1.tpm?.value, "(预期: 80000)");
    console.log("  RPM:", userConfig1.rpm?.value, "(预期: 500)"); // 新增
    console.log("  软限制:", userConfig1.soft_limit?.value, "(预期: 500)");

    // 客户类型用户
    const userConfig2 = gatewayControlService.getConfig({
      customer_type: customerTypeId, // ✅ 现在customerTypeId已定义
    });
    console.log("\n场景2 - 客户类型用户:");
    console.log("  TPM:", userConfig2.tpm?.value, "(预期: 20000)");
    console.log("  RPM:", userConfig2.rpm?.value, "(预期: 120)"); // 新增
    console.log("  软限制:", userConfig2.soft_limit?.value, "(预期: 200)");

    // 个人用户
    const userConfig3 = gatewayControlService.getConfig({});
    console.log("\n场景3 - 个人用户（全局）:");
    console.log("  TPM:", userConfig3.tpm?.value, "(预期: 10000)");
    console.log("  RPM:", userConfig3.rpm?.value, "(预期: 60)"); // 新增
    console.log("  软限制:", userConfig3.soft_limit?.value, "(预期: 100)");
  }

  console.log("\n=== 验证完成 ===");
}

checkGatewayConfig().catch(console.error);
