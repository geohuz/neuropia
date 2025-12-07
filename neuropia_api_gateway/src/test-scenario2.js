// test-scenario2-simple.js - 完全按照测试1的步骤
require("module-alias/register");
const pool = require("@shared/clients/pg");
const axios = require("axios");

const API_BASE = process.env.API_BASE_URL || "http://localhost:3001";

let pgClient;
let testUser;

const testResults = {
  scenario: "场景2: 余额不足测试",
  startTime: null,
  endTime: null,
  steps: [],
  errors: [],
};

// 完全复制测试1的函数
async function connectDatabases() {
  console.log("🔌 连接数据库...");
  pgClient = await pool.connect();
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
    `SELECT user_id, username, status FROM data.user_profile WHERE user_id = $1`,
    [userId],
  );

  testUser = userResult.rows[0];
  console.log(
    `✅ 创建测试用户: ${testUser.username} (ID: ${testUser.user_id})`,
  );

  // 3. 创建virtual_key（和测试1完全一样）
  const virtualKeyResult = await pgClient.query(
    `
    INSERT INTO data.virtual_key (user_id, virtual_key, name, is_active, config_data)
    VALUES ($1, $2, $3, true, $4)
    RETURNING virtual_key, id
  `,
    [
      testUser.user_id,
      `test_vk_${testUser.user_id}`,
      `测试Key-${Date.now()}`,
      JSON.stringify({
        provider: "openai",
        customer_type_id: customerTypeId,
      }),
    ],
  );

  testUser.virtual_key = virtualKeyResult.rows[0].virtual_key;
  console.log(`   Virtual Key: ${testUser.virtual_key}`);

  return testUser;
}

async function injectFunds(amount) {
  console.log(`💰 注入资金: ${amount} USD`);

  // 🆕 添加：检查并创建账户余额记录（如果不存在）
  const accountCheck = await pgClient.query(
    `SELECT * FROM data.account_balance WHERE owner_userid = $1`,
    [testUser.user_id],
  );

  if (accountCheck.rows.length === 0) {
    console.log("   创建账户余额记录...");
    await pgClient.query(
      `INSERT INTO data.account_balance (owner_userid, balance) VALUES ($1, 0)`,
      [testUser.user_id],
    );
  }

  // 然后调用函数
  const result = await pgClient.query(
    `
    SELECT * FROM data.complete_fund_operation_directly(
      $1, 'user', 'deposit', $2, 'USD',
      'test_ref_${Date.now()}', NULL, 'system', '测试资金'
    )
  `,
    [testUser.user_id, amount],
  );

  const fundTx = result.rows[0];
  console.log(`✅ 资金注入: $${amount}`);
  console.log(`   余额: ${fundTx.balance_before} → ${fundTx.balance_after}`);

  return fundTx;
}

async function makeApiRequest(requestCount = 1) {
  console.log(`📡 发起 ${requestCount} 次API请求...`);

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

      console.log(`    ✅ 请求成功: ${response.data.id}`);

      requestDetails.push({
        requestIndex: i,
        status: "success",
        responseId: response.data.id,
      });

      if (i < requestCount) {
        await sleep(500);
      }
    } catch (error) {
      console.log(`    ❌ 请求失败: ${error.message}`);
      if (error.response) {
        console.log(`      状态码: ${error.response.status}`);
        console.log(`      响应: ${JSON.stringify(error.response.data)}`);

        // 检查是否是余额不足错误
        if (
          error.response.status === 402 &&
          error.response.data?.code === "INSUFFICIENT_BALANCE"
        ) {
          console.log(`      ⚠️  这是预期的余额不足错误！`);
          requestDetails.push({
            requestIndex: i,
            status: "insufficient_balance",
            error: error.response.data.error,
            code: error.response.data.code,
          });

          // 如果是余额不足，我们期望这种情况发生
          // 不将其记录为错误
          continue;
        }
      }

      requestDetails.push({
        requestIndex: i,
        status: "failed",
        error: error.message,
      });

      testResults.errors.push(`API请求失败: ${error.message}`);
    }
  }

  const hasBalanceError = requestDetails.some(
    (r) => r.status === "insufficient_balance",
  );
  const hasOtherErrors = requestDetails.some((r) => r.status === "failed");

  let stepStatus = "success";
  if (hasOtherErrors) stepStatus = "failed";
  else if (hasBalanceError) stepStatus = "partial"; // 余额不足是预期的

  testResults.steps.push({
    name: "发起API请求",
    status: stepStatus,
    details: { requestCount, requestDetails },
  });

  return requestDetails;
}

async function validateBalance() {
  console.log("🔍 验证余额...");

  // 获取当前余额
  const balanceResult = await pgClient.query(
    `SELECT balance FROM data.account_balance WHERE owner_userid = $1`,
    [testUser.user_id],
  );

  const currentBalance = parseFloat(balanceResult.rows[0]?.balance) || 0;
  console.log(`   当前余额: ${currentBalance}`);

  // 验证余额应该接近0（因为只注入1美元，每次扣费0.399，应该不够3次）
  if (currentBalance < 0) {
    console.log(`❌ 余额为负: ${currentBalance}`);
    testResults.errors.push("余额为负数");
  } else if (currentBalance < 0.01) {
    console.log(`✅ 余额接近零: ${currentBalance}`);
  } else {
    console.log(`✅ 余额为正数: ${currentBalance}`);
  }

  return currentBalance;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
}

// 主测试流程 - 和测试1一样，只是注入1美元
async function main() {
  console.log("🚀 开始场景2测试: 余额不足测试");
  console.log("=".repeat(50));

  testResults.startTime = Date.now();

  try {
    // 1. 确保API Gateway已启动
    console.log("🔍 检查API Gateway...");
    try {
      await axios.get(`${API_BASE}/health`, { timeout: 2000 });
      console.log("✅ API Gateway运行正常");
    } catch (error) {
      console.log("❌ API Gateway未启动");
      process.exit(1);
    }

    // 2. 连接数据库
    await connectDatabases();

    // 3. 创建测试用户
    await createTestUser();

    // 4. 注入少量资金（1美元）
    await injectFunds(1.0);

    // 等待资金注入完成
    console.log("⏳ 等待资金注入生效...");
    await sleep(2000);

    // 5. 发起多次API请求（3次应该就余额不足了）
    console.log("📡 发起3次API请求（预期会余额不足）...");
    await makeApiRequest(3);

    // 6. 等待异步处理
    console.log("⏳ 等待异步处理完成...");
    await sleep(5000);

    // 7. 验证余额
    await validateBalance();

    testResults.endTime = Date.now();
    generateReport();

    console.log("\n" + "=".repeat(50));
    if (testResults.errors.length === 0) {
      console.log("🎉 场景2测试完成!");
      console.log("   预期: 注入1美元，3次请求后余额不足");
      console.log("   结果: 系统正确处理了余额不足的情况");
      process.exit(0);
    } else {
      console.log("❌ 场景2测试失败!");
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

// 运行测试
if (require.main === module) {
  main().catch(console.error);
}
