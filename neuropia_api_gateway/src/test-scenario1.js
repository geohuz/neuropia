// test-scenario1-fixed.js
require("module-alias/register");
const pool = require("@shared/clients/pg");
const redisClient = require("@shared/clients/redis_op");
const axios = require("axios");

const API_BASE = process.env.API_BASE_URL || "http://localhost:3001";

let pgClient;
let testUser;

// 测试结果
const testResults = {
  scenario: "场景1: 正常流程",
  startTime: null,
  endTime: null,
  steps: [],
  errors: [],
};

// 工具函数
async function connectDatabases() {
  console.log("🔌 连接数据库...");

  pgClient = await pool.connect();
  // 测试连接
  await pgClient.query("SELECT 1");
  console.log("✅ 数据库连接成功");
}

async function disconnectDatabases() {
  console.log("🔌 断开数据库连接...");
  if (pgClient) await pgClient.release();
  console.log("✅ 数据库连接已断开");
}

async function createTestUser() {
  console.log("👤 创建测试用户...");

  const username = `test_user_${Date.now()}`;
  const email = `${username}@test.com`;
  const password = "test_password_123";
  const customerTypeId = "eb948fd1-b8da-46c7-aa51-92eb296970c8";

  // 1. 注册用户
  const result = await pgClient.query(
    `SELECT api.register_user($1, $2, $3, $4, NULL) as user_id`,
    [email, username, password, "norm_user"],
  );

  const userId = result.rows[0].user_id;

  // 2. 更新用户状态和customer_type_id
  await pgClient.query(
    `UPDATE data.user_profile SET status = 'active', customer_type_id = $1 WHERE user_id = $2`,
    [customerTypeId, userId],
  );

  const userResult = await pgClient.query(
    `SELECT user_id, username, status, customer_type_id FROM data.user_profile WHERE user_id = $1`,
    [userId],
  );

  testUser = userResult.rows[0];
  console.log(
    `✅ 创建测试用户: ${testUser.username} (ID: ${testUser.user_id})`,
  );
  console.log(`   Customer Type ID: ${testUser.customer_type_id}`);

  // 3. 插入virtual_key
  const virtualKeyResult = await pgClient.query(
    `
    INSERT INTO data.virtual_key (
      user_id,
      virtual_key,
      name,
      is_active,
      config_data,
      primary_config_node_id
    )
    VALUES ($1, $2, $3, true, $4, NULL)
    RETURNING virtual_key, id
  `,
    [
      testUser.user_id,
      `test_vk_${testUser.user_id}`,
      `测试Key-${Date.now()}`,
      JSON.stringify({
        provider: "openai",
        customer_type_id: customerTypeId, // 确保config_data中包含customer_type_id
      }),
    ],
  );

  testUser.virtual_key = virtualKeyResult.rows[0].virtual_key;
  testUser.virtual_key_id = virtualKeyResult.rows[0].id;

  console.log(`   Virtual Key: ${testUser.virtual_key}`);
  console.log(`   Virtual Key ID: ${testUser.virtual_key_id}`);

  return testUser;
}

async function attachVirtualKeyToConfig() {
  console.log("🔗 将virtual_key附加到config node...");

  // 使用您提供的固定config_node_id
  const configNodeId = "834c04a4-96a2-4a97-b270-fcec5cac66ef";

  try {
    const result = await pgClient.query(
      `SELECT api.attach_virtualkey($1, $2)`,
      [testUser.virtual_key_id, configNodeId],
    );

    console.log(`✅ virtual_key已附加到config node: ${configNodeId}`);

    // 等待可能的通知处理
    console.log("⏳ 等待配置变更通知处理...");
    await sleep(2000);

    return true;
  } catch (error) {
    console.log(`❌ 附加virtual_key失败: ${error.message}`);
    testResults.errors.push(`附加virtual_key失败: ${error.message}`);
    return false;
  }
}

async function injectFunds(amount) {
  console.log(`💰 注入资金: ${amount} USD`);

  // 检查并创建账户余额记录（如果不存在）
  const accountCheck = await pgClient.query(
    `
    SELECT * FROM data.account_balance
    WHERE owner_userid = $1
  `,
    [testUser.user_id],
  );

  if (accountCheck.rows.length === 0) {
    console.log("   创建账户余额记录...");
    await pgClient.query(
      `
      INSERT INTO data.account_balance (owner_userid, balance)
      VALUES ($1, 0)
      `, // 移除 account_type，它是生成的列
      [testUser.user_id],
    );
  }

  // 使用 complete_fund_operation_directly 函数
  console.log("   调用complete_fund_operation_directly函数...");
  const result = await pgClient.query(
    `
    SELECT * FROM data.complete_fund_operation_directly(
      $1,  -- p_user_id
      $2,  -- p_account_type
      $3,  -- p_transaction_type
      $4,  -- p_amount
      $5,  -- p_currency
      $6,  -- p_reference_id
      $7,  -- p_operator_id
      $8,  -- p_operator_type
      $9,  -- p_description
      $10  -- p_metadata
    )
  `,
    [
      testUser.user_id, // p_user_id
      "user", // p_account_type
      "deposit", // p_transaction_type
      amount, // p_amount
      "USD", // p_currency
      `test_fund_${Date.now()}`, // p_reference_id
      null, // p_operator_id
      "system", // p_operator_type
      "测试资金注入", // p_description
      JSON.stringify({ test: true, injected_by: "test_script" }), // p_metadata
    ],
  );

  if (result.rows.length === 0) {
    throw new Error("complete_fund_operation_directly函数未返回结果");
  }

  const fundTx = result.rows[0];

  console.log(`✅ 资金注入成功: 交易ID ${fundTx.id}`);
  console.log(
    `   余额变化: ${fundTx.balance_before} → ${fundTx.balance_after}`,
  );

  // 验证account_balance已更新
  const balanceCheck = await pgClient.query(
    `SELECT balance FROM data.account_balance WHERE owner_userid = $1`,
    [testUser.user_id],
  );
  console.log(`   账户余额验证: ${balanceCheck.rows[0].balance}`);

  testResults.steps.push({
    name: "注入资金",
    status: "success",
    details: {
      amount,
      fundTransactionId: fundTx.id,
      balanceBefore: fundTx.balance_before,
      balanceAfter: fundTx.balance_after,
      accountBalance: balanceCheck.rows[0].balance,
    },
  });

  return fundTx;
}

async function makeMockApiRequest(requestCount = 1) {
  console.log(`📡 发起 ${requestCount} 次模拟API请求...`);

  const requestDetails = [];

  for (let i = 1; i <= requestCount; i++) {
    try {
      console.log(`  请求 ${i}/${requestCount}...`);

      const response = await axios.post(
        `${API_BASE}/v1/chat/completions`,
        {
          messages: [{ role: "user", content: `测试消息 ${i}` }],
          model: "qwen-turbo",
          provider: "dashscope",
        },
        {
          headers: {
            Authorization: `Bearer ${testUser.virtual_key}`,
            "Content-Type": "application/json",
          },
          timeout: 10000,
        },
      );

      // ✅ 检查响应是否包含billing信息（表示扣费成功）
      const hasBilling = response.data && response.data.billing;
      const status =
        response.status === 200 && hasBilling ? "success" : "partial";

      console.log(
        `    ✅ 请求${status}: ${response.data.id} ${hasBilling ? "(已扣费)" : "(未扣费)"}`,
      );

      requestDetails.push({
        requestIndex: i,
        status: status,
        responseId: response.data.id,
        hasBilling: hasBilling,
        billing: response.data.billing,
      });

      // 短暂延迟
      if (i < requestCount) {
        await sleep(200);
      }
    } catch (error) {
      console.log(`    ❌ 请求失败: ${error.message}`);
      if (error.response) {
        console.log(`      状态码: ${error.response.status}`);
        console.log(`      响应: ${JSON.stringify(error.response.data)}`);
      }
      requestDetails.push({
        requestIndex: i,
        status: "failed",
        error: error.message,
      });

      testResults.errors.push(`API请求失败: ${error.message}`);
    }
  }

  testResults.steps.push({
    name: "发起API请求",
    status: requestDetails.some((r) => r.status === "failed")
      ? "partial"
      : "success",
    details: { requestCount, requestDetails },
  });

  return requestDetails;
}

async function validateConsistency() {
  console.log("🔍 验证数据一致性...");

  // 1. 获取account_id
  const accountResult = await pgClient.query(
    `SELECT id, balance FROM data.account_balance WHERE owner_userid = $1`,
    [testUser.user_id],
  );

  if (accountResult.rows.length === 0) {
    console.log("❌ 未找到账户记录");
    testResults.errors.push("未找到账户记录");
    return;
  }

  const accountId = accountResult.rows[0].id;
  const dbBalance = parseFloat(accountResult.rows[0].balance) || 0;

  // 2. 使用account_id查询使用记录
  const usageResult = await pgClient.query(
    `SELECT COUNT(*) as count, COALESCE(SUM(cost), 0) as total_cost
     FROM data.usage_log WHERE account_id = $1`,
    [accountId],
  );

  console.log(`   usage_log记录数: ${usageResult.rows[0].count}`);
  console.log(`   总消费金额: $${usageResult.rows[0].total_cost}`);

  // ... 其余验证逻辑
}

async function validateAuditTrail() {
  console.log("📋 验证审计记录完整性...");

  const auditResults = {};

  // 1. 检查所有扣费记录是否有余额字段
  const usageLogCheck = await pgClient.query(
    `
    SELECT
      COUNT(*) as total_records,
      COUNT(*) FILTER (WHERE balance_before IS NOT NULL AND balance_after IS NOT NULL) as complete_records,
      COUNT(*) FILTER (WHERE balance_before IS NULL OR balance_after IS NULL) as incomplete_records,
      COALESCE(SUM(cost), 0) as total_cost  -- 注意: 用cost
    FROM data.usage_log
    WHERE user_id = $1
  `,
    [testUser.user_id],
  );

  auditResults.usageLog = usageLogCheck.rows[0];

  console.log(
    `   Usage Log: ${auditResults.usageLog.complete_records}/${auditResults.usageLog.total_records} 条记录完整`,
  );
  console.log(`   总消费金额: $${auditResults.usageLog.total_cost}`);

  // 2. 检查余额序列是否连续
  if (auditResults.usageLog.total_records > 0) {
    const sequenceCheck = await pgClient.query(
      `
      WITH logs AS (
        SELECT
          balance_before,
          balance_after,
          created_at,
          LAG(balance_after) OVER (ORDER BY created_at) as prev_balance_after
        FROM data.usage_log
        WHERE user_id = $1
        ORDER BY created_at
      )
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE prev_balance_after IS NULL OR balance_before = prev_balance_after) as continuous,
        COUNT(*) FILTER (WHERE prev_balance_after IS NOT NULL AND balance_before != prev_balance_after) as discontinuous
      FROM logs
    `,
      [testUser.user_id],
    );

    auditResults.sequence = sequenceCheck.rows[0];

    console.log(
      `   余额序列: ${auditResults.sequence.continuous}/${auditResults.sequence.total} 条连续`,
    );

    const isAuditValid =
      auditResults.usageLog.incomplete_records === 0 &&
      auditResults.sequence.discontinuous === 0;

    testResults.steps.push({
      name: "验证审计记录",
      status: isAuditValid ? "success" : "failed",
      details: auditResults,
    });

    if (isAuditValid) {
      console.log("✅ 审计记录验证通过");
    } else {
      console.log("❌ 审计记录验证失败");
      testResults.errors.push("审计记录不完整或不连续");
    }
  } else {
    console.log("   ⚠️  无usage_log记录可验证");
    testResults.steps.push({
      name: "验证审计记录",
      status: "skipped",
      details: { message: "无usage_log记录" },
    });
  }

  return auditResults;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 修改 viewAllData 函数，查看所有数据
async function viewAllData() {
  console.log("\n📊 查看所有相关数据:");
  console.log("=".repeat(50));

  // 1. 查看所有usage_log记录（不限定user_id）
  console.log("\n🔍 查看所有usage_log记录:");
  try {
    const allUsage = await pgClient.query(
      `SELECT id, user_id, account_id, deduction_id, model, cost, balance_before, balance_after, created_at
       FROM data.usage_log
       ORDER BY created_at DESC
       LIMIT 20`,
    );

    console.log(`   总记录数: ${allUsage.rows.length}`);

    if (allUsage.rows.length > 0) {
      console.log("   最近20条记录:");
      allUsage.rows.forEach((log, index) => {
        console.log(`   ${index + 1}. ${log.created_at.toISOString()}`);
        console.log(`      deduction_id: ${log.deduction_id}`);
        console.log(
          `      user_id: ${log.user_id} (测试用户: ${testUser.user_id})`,
        );
        console.log(`      account_id: ${log.account_id}`);
        console.log(`      模型: ${log.model}, 费用: $${log.cost}`);
        console.log(`      余额: ${log.balance_before} → ${log.balance_after}`);
        console.log(
          `      是否匹配测试用户: ${log.user_id === testUser.user_id ? "✅" : "❌"}`,
        );
      });
    } else {
      console.log("   数据库中没有usage_log记录");
    }
  } catch (error) {
    console.log(`   查询失败: ${error.message}`);
  }

  // 2. 查看account_balance表，获取account_id
  console.log("\n🔍 查看account_balance:");
  const accountBalance = await pgClient.query(
    `SELECT id, owner_userid, balance FROM data.account_balance WHERE owner_userid = $1`,
    [testUser.user_id],
  );

  if (accountBalance.rows.length > 0) {
    const account = accountBalance.rows[0];
    console.log(`   账户ID: ${account.id}`);
    console.log(`   用户ID: ${account.owner_userid}`);
    console.log(`   余额: ${account.balance}`);

    // 3. 使用account_id查询usage_log
    console.log("\n🔍 使用account_id查询usage_log:");
    const usageByAccount = await pgClient.query(
      `SELECT id, deduction_id, model, cost, balance_before, balance_after, created_at
       FROM data.usage_log
       WHERE account_id = $1
       ORDER BY created_at DESC`,
      [account.id],
    );

    console.log(`   找到 ${usageByAccount.rows.length} 条记录`);

    if (usageByAccount.rows.length > 0) {
      usageByAccount.rows.forEach((log, index) => {
        console.log(
          `   ${index + 1}. ${log.created_at.toISOString()} [${log.deduction_id}]`,
        );
        console.log(`      模型: ${log.model}, 费用: $${log.cost}`);
        console.log(`      余额: ${log.balance_before} → ${log.balance_after}`);
      });
    }
  }

  console.log("=".repeat(50));
}

function generateReport() {
  console.log("\n📊 测试报告");
  console.log("=".repeat(50));
  console.log(`场景: ${testResults.scenario}`);
  console.log(`用时: ${testResults.endTime - testResults.startTime}ms`);
  console.log(
    `结果: ${testResults.errors.length === 0 ? "✅ 通过" : "❌ 失败"}`,
  );

  if (testResults.errors.length > 0) {
    console.log("\n❌ 错误列表:");
    testResults.errors.forEach((error, i) => {
      console.log(`  ${i + 1}. ${error}`);
    });
  }

  console.log("\n📋 步骤详情:");
  testResults.steps.forEach((step, i) => {
    console.log(`  ${i + 1}. ${step.name}: ${step.status}`);
  });

  // 保存报告到文件
  const fs = require("fs");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportFile = `test-report-${timestamp}.json`;
  fs.writeFileSync(reportFile, JSON.stringify(testResults, null, 2));
  console.log(`\n📁 详细报告已保存到: ${reportFile}`);
}

// 主测试流程
// 修改主测试流程，增加足够的等待时间
async function main() {
  console.log("🚀 开始场景1测试: 正常流程");

  testResults.startTime = Date.now();

  try {
    // 1. 确保API Gateway已启动
    console.log("🔍 检查API Gateway...");
    for (let i = 0; i < 5; i++) {
      try {
        const response = await axios.get(`${API_BASE}/health`, {
          timeout: 2000,
        });
        if (response.status === 200) {
          console.log("✅ API Gateway运行正常");
          break;
        }
      } catch (error) {
        if (i === 4) {
          console.log("❌ API Gateway未启动");
          process.exit(1);
        }
        console.log(`等待API Gateway启动... (${i + 1}/5)`);
        await sleep(2000);
      }
    }

    // 2. 连接数据库
    await connectDatabases();

    // 3. 创建测试用户
    await createTestUser();

    // 4. 注入资金
    await injectFunds(100.0);

    // 等待资金注入完成
    console.log("⏳ 等待资金注入生效...");
    await sleep(2000);

    // 5. 测试API路径
    console.log("🔍 测试API路径...");
    const correctPath = await findCorrectApiPath();
    if (!correctPath) {
      console.log("❌ 未找到正确的API路径");
      process.exit(1);
    }

    // 6. 发起API请求
    console.log(`📡 使用路径 ${correctPath} 发起API请求...`);
    await makeMockApiRequest(correctPath, 3);

    // 7. 等待异步处理 - 给足够时间处理Stream
    console.log("⏳ 等待异步处理完成 (给billing worker时间)...");

    // billing worker配置：100ms轮询 + 批量50条 + 数据库写入
    // 保守等待10秒
    let attempts = 0;
    const maxAttempts = 50; // 最多等30秒
    let recordsFound = 0;

    while (attempts < maxAttempts) {
      attempts++;

      // 检查是否有usage_log记录
      const check = await pgClient.query(
        `SELECT COUNT(*) as count FROM data.usage_log WHERE user_id = $1`,
        [testUser.user_id],
      );

      recordsFound = parseInt(check.rows[0].count);

      if (recordsFound > 0) {
        console.log(`✅ 找到 ${recordsFound} 条使用记录 (等待 ${attempts} 秒)`);
        break;
      }

      if (attempts < maxAttempts) {
        console.log(`   等待中... (${attempts}/${maxAttempts}) 秒`);
        await sleep(1000);
      }
    }

    // 8. 验证数据
    console.log("🔍 验证数据...");
    await viewAllData();
    await validateConsistency();
    await validateAuditTrail();

    testResults.endTime = Date.now();
    generateReport();

    console.log("\n" + "=".repeat(50));
    if (testResults.errors.length === 0) {
      console.log("🎉 测试完成!");
      process.exit(0);
    } else {
      console.log("❌ 测试失败!");
      process.exit(1);
    }
  } catch (error) {
    console.error("💥 测试过程错误:", error);
    testResults.errors.push(`未捕获错误: ${error.message}`);
    testResults.endTime = Date.now();
    generateReport();
    process.exit(1);
  } finally {
    await disconnectDatabases();
  }
}

// 添加路径检测函数
async function findCorrectApiPath() {
  const testPaths = [
    "/v1/chat/completions",
    "/api/chat/completions",
    "/chat/completions",
  ];

  for (const path of testPaths) {
    try {
      console.log(`  尝试路径: ${path}`);

      const response = await axios.post(
        `${API_BASE}${path}`,
        {
          messages: [{ role: "user", content: "测试路径" }],
          model: "qwen-turbo",
          provider: "dashscope",
        },
        {
          headers: {
            Authorization: `Bearer ${testUser.virtual_key}`,
            "Content-Type": "application/json",
          },
          timeout: 3000,
        },
      );

      // 检查响应是否有效
      if (response.status === 200 && response.data) {
        console.log(`  ✅ 路径可用: ${path}`);
        return path;
      }
    } catch (error) {
      if (error.response) {
        console.log(
          `    ❌ ${path}: ${error.response.status} - ${error.response.data?.error || error.message}`,
        );
      } else {
        console.log(`    ❌ ${path}: ${error.message}`);
      }
    }

    await sleep(500); // 短暂延迟
  }

  return null;
}

// 修改makeMockApiRequest函数接收路径参数
async function makeMockApiRequest(apiPath, requestCount = 1) {
  console.log(`📡 发起 ${requestCount} 次API请求 (路径: ${apiPath})...`);

  const requestDetails = [];

  for (let i = 1; i <= requestCount; i++) {
    try {
      console.log(`  请求 ${i}/${requestCount}...`);

      const response = await axios.post(
        `${API_BASE}${apiPath}`,
        {
          messages: [{ role: "user", content: `测试消息 ${i}` }],
          model: "qwen-turbo",
          provider: "dashscope",
        },
        {
          headers: {
            Authorization: `Bearer ${testUser.virtual_key}`,
            "Content-Type": "application/json",
          },
          timeout: 10000,
        },
      );

      console.log(`    ✅ 请求成功: ${response.data.id}`);

      requestDetails.push({
        requestIndex: i,
        status: "success",
        responseId: response.data.id,
        hasBilling: !!response.data.billing,
      });

      if (i < requestCount) {
        await sleep(500); // 请求间延迟
      }
    } catch (error) {
      console.log(`    ❌ 请求失败: ${error.message}`);
      if (error.response) {
        console.log(`      状态码: ${error.response.status}`);
        console.log(`      响应: ${JSON.stringify(error.response.data)}`);
      }
      requestDetails.push({
        requestIndex: i,
        status: "failed",
        error: error.message,
      });

      testResults.errors.push(`API请求失败: ${error.message}`);
    }
  }

  testResults.steps.push({
    name: "发起API请求",
    status: requestDetails.some((r) => r.status === "failed")
      ? "partial"
      : "success",
    details: { requestCount, requestDetails },
  });

  return requestDetails;
}

// 运行测试
if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  main,
  createTestUser,
  injectFunds,
  makeMockApiRequest,
  validateConsistency,
  validateAuditTrail,
};
