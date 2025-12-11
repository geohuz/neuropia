// test/config-flow-correct.js
require("module-alias/register");
const pool = require("@shared/clients/pg");

async function testConfigFlow() {
  console.log("=== 配置下发流程测试（完整版） ===\n");

  const tenantId = "9d865a1b-2c8b-444e-9172-39e2c3517292";
  const customerTypeId = "eb948fd1-b8da-46c7-aa51-92eb296970c8";

  // 1. 清空配置
  console.log("1. 清空现有配置...");
  await pool.query("DELETE FROM data.gateway_control_config");
  console.log("✅ 配置表已清空\n");

  // 2. 插入完整的三层配置体系
  console.log("2. 插入完整的三层配置体系...");

  // 全局配置（个人用户）
  await pool.query(`
    INSERT INTO data.gateway_control_config
    (target_type, control_type, control_value, time_window_seconds, is_active)
    VALUES
    ('global', 'tpm', 10000, 60, true),
    ('global', 'rpm', 60, 60, true),  -- 新增：全局RPM
    ('global', 'soft_limit', 100, NULL, true),
    ('global', 'hard_limit', 50, NULL, true)
  `);

  // 客户类型配置
  await pool.query(
    `
    INSERT INTO data.gateway_control_config
    (target_type, target_id, control_type, control_value, time_window_seconds, is_active)
    VALUES
    ('customer_type', $1, 'tpm', 20000, 60, true),
    ('customer_type', $1, 'rpm', 120, 60, true),  -- 新增：客户类型RPM
    ('customer_type', $1, 'soft_limit', 200, NULL, true),
    ('customer_type', $1, 'hard_limit', 100, NULL, true)
  `,
    [customerTypeId],
  );

  // 租户配置 - 使用批量插入提高效率
  const tenantConfigs = [
    // 租户全局配置
    [tenantId, "tpm", 50000, 60, null, null],
    [tenantId, "rpm", 1000, 60, null, null], // 租户全局RPM
    [tenantId, "soft_limit", 500, null, null, null],
    [tenantId, "hard_limit", 200, null, null, null],

    // 租户+openai配置
    [tenantId, "tpm", 100000, 60, "openai", null],
    [tenantId, "rpm", 500, 60, "openai", null], // 租户+openai RPM

    // 租户+openai+模型配置
    [tenantId, "tpm", 80000, 60, "openai", "gpt-4"],
  ];

  for (const config of tenantConfigs) {
    await pool.query(
      `
      INSERT INTO data.gateway_control_config
      (target_type, target_id, control_type, control_value, time_window_seconds, provider_name, model_name, is_active)
      VALUES ('tenant', $1, $2, $3, $4, $5, $6, true)
      `,
      config,
    );
  }

  console.log("✅ 插入配置完成：");
  console.log("  - 全局: TPM=10000/60s, RPM=60/60s, Soft=100, Hard=50");
  console.log("  - 客户类型: TPM=20000/60s, RPM=120/60s, Soft=200, Hard=100");
  console.log("  - 租户:");
  console.log("    * 全局: TPM=50000/60s, RPM=1000/60s, Soft=500, Hard=200");
  console.log("    * +openai: TPM=100000/60s, RPM=500/60s");
  console.log("    * +openai+gpt-4: TPM=80000/60s\n");

  // 3. 生成并验证payload
  console.log("3. 生成并验证配置payload...");
  const result = await pool.query(
    "SELECT jsonb_pretty(data.generate_gateway_config_payload()) as payload",
  );
  const payload = JSON.parse(result.rows[0].payload);

  console.log("配置树结构验证:");

  // 全局配置
  console.log("- 全局配置:");
  console.log(
    `  TPM: ${payload.global?.tpm?.value}/${payload.global?.tpm?.time_window}s`,
  );
  console.log(
    `  RPM: ${payload.global?.rpm?.value}/${payload.global?.rpm?.time_window}s`,
  );
  console.log(`  软限制: ${payload.global?.soft_limit?.value}`);
  console.log(`  硬限制: ${payload.global?.hard_limit?.value}`);

  // 客户类型配置
  console.log(`- 客户类型配置 (${customerTypeId}):`);
  if (payload.customer_types?.[customerTypeId]) {
    const ct = payload.customer_types[customerTypeId];
    console.log(`  TPM: ${ct.tpm?.value}/${ct.tpm?.time_window}s`);
    console.log(`  RPM: ${ct.rpm?.value}/${ct.rpm?.time_window}s`);
    console.log(`  软限制: ${ct.soft_limit?.value}`);
    console.log(`  硬限制: ${ct.hard_limit?.value}`);
  } else {
    console.log("  ❌ 客户类型配置缺失");
  }

  // 租户配置
  console.log(`- 租户配置 (${tenantId}):`);
  const tenant = payload.tenants?.[tenantId];
  if (tenant) {
    console.log(
      `  全局TPM: ${tenant.global?.tpm?.value}/${tenant.global?.tpm?.time_window}s`,
    );
    console.log(
      `  全局RPM: ${tenant.global?.rpm?.value}/${tenant.global?.rpm?.time_window}s`,
    );
    console.log(`  全局软限制: ${tenant.global?.soft_limit?.value}`);
    console.log(`  全局硬限制: ${tenant.global?.hard_limit?.value}`);

    if (tenant.providers?.openai) {
      console.log(
        `  openai全局TPM: ${tenant.providers.openai.global?.tpm?.value}/${tenant.providers.openai.global?.tpm?.time_window}s`,
      );
      console.log(
        `  openai全局RPM: ${tenant.providers.openai.global?.rpm?.value}/${tenant.providers.openai.global?.rpm?.time_window}s`,
      );
      console.log(
        `  openai+gpt-4 TPM: ${tenant.providers.openai.models?.["gpt-4"]?.tpm?.value}/${tenant.providers.openai.models?.["gpt-4"]?.tpm?.time_window}s`,
      );
    }
  } else {
    console.log("  ❌ 租户配置缺失");
  }

  // 4. 验证配置优先级
  console.log("\n4. 验证配置优先级（模拟查找）:");

  function simulateLookup(
    tenant = null,
    customerType = null,
    provider = null,
    model = null,
  ) {
    let config = { ...payload.global };

    // 客户类型覆盖
    if (customerType && payload.customer_types?.[customerType]) {
      Object.assign(config, payload.customer_types[customerType]);
    }

    // 租户覆盖
    if (tenant && payload.tenants?.[tenant]) {
      const tenantConfig = payload.tenants[tenant];
      Object.assign(config, tenantConfig.global);

      // 供应商覆盖
      if (provider && tenantConfig.providers?.[provider]) {
        const providerConfig = tenantConfig.providers[provider];
        Object.assign(config, providerConfig.global);

        // 模型覆盖（只对TPM有效）
        if (model && providerConfig.models?.[model]) {
          Object.assign(config, providerConfig.models[model]);
        }
      }
    }

    return config;
  }

  console.log("场景1: 个人用户（全局）");
  const config1 = simulateLookup();
  console.log(`  TPM: ${config1.tpm?.value} (预期: 10000)`);
  console.log(`  RPM: ${config1.rpm?.value} (预期: 60)`);

  console.log("\n场景2: 客户类型用户");
  const config2 = simulateLookup(null, customerTypeId);
  console.log(`  TPM: ${config2.tpm?.value} (预期: 20000)`);
  console.log(`  RPM: ${config2.rpm?.value} (预期: 120)`);

  console.log("\n场景3: 租户用户（openai的gpt-4）");
  const config3 = simulateLookup(tenantId, null, "openai", "gpt-4");
  console.log(`  TPM: ${config3.tpm?.value} (预期: 80000)`);
  console.log(`  RPM: ${config3.rpm?.value} (预期: 500)`);
  console.log(`  软限制: ${config3.soft_limit?.value} (预期: 500)`);
  console.log(`  硬限制: ${config3.hard_limit?.value} (预期: 200)`);

  console.log("\n场景4: 租户用户（仅openai，无模型）");
  const config4 = simulateLookup(tenantId, null, "openai", null);
  console.log(`  TPM: ${config4.tpm?.value} (预期: 100000)`);
  console.log(`  RPM: ${config4.rpm?.value} (预期: 500)`);

  console.log("\n场景5: 租户用户（无供应商）");
  const config5 = simulateLookup(tenantId, null, null, null);
  console.log(`  TPM: ${config5.tpm?.value} (预期: 50000)`);
  console.log(`  RPM: ${config5.rpm?.value} (预期: 1000)`);

  console.log("\n=== 测试完成 ===");
  console.log("检查PostgreSQL日志确认触发器工作，NOTICE应输出配置payload。");
  console.log("然后运行 gateway-config-check.js 验证Gateway是否正确加载配置。");
}

testConfigFlow().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
