// test-scenario3.js - 直接复制测试1的代码，只改并发部分
require("module-alias/register");
const pool = require("@shared/clients/pg");
const axios = require("axios");

const API_BASE = process.env.API_BASE_URL || "http://localhost:3001";

let pgClient;
let testUser;

async function connectDatabases() {
  console.log("🔌 连接数据库...");
  pgClient = await pool.connect();
  console.log("✅ 数据库连接成功");
}

async function createTestUser() {
  console.log("👤 创建测试用户...");

  const username = `test_concurrent_${Date.now()}`;
  const email = `${username}@test.com`;
  const password = "test_password_123";
  const customerTypeId = "eb948fd1-b8da-46c7-aa51-92eb296970c8";

  // ✅ 完全复制测试1
  const result = await pgClient.query(
    `SELECT api.register_user($1, $2, $3, $4, NULL) as user_id`,
    [email, username, password, "norm_user"],
  );

  const userId = result.rows[0].user_id;

  await pgClient.query(
    `UPDATE data.user_profile SET status = 'active', customer_type_id = $1 WHERE user_id = $2`,
    [customerTypeId, userId],
  );

  testUser = { user_id: userId, username };
  console.log(
    `✅ 创建测试用户: ${testUser.username} (ID: ${testUser.user_id})`,
  );

  // ✅ 检查并创建账户余额记录
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

  // ✅ 创建virtual_key
  const virtualKeyResult = await pgClient.query(
    `
    INSERT INTO data.virtual_key (user_id, virtual_key, name, is_active, config_data)
    VALUES ($1, $2, $3, true, $4)
    RETURNING virtual_key
  `,
    [
      testUser.user_id,
      `test_vk_${testUser.user_id}`,
      `并发测试Key`,
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

  // ✅ 复制测试1的注入逻辑
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

  const result = await pgClient.query(
    `
    SELECT * FROM data.complete_fund_operation_directly(
      $1, 'user', 'deposit', $2, 'USD',
      'concurrent_test', NULL, 'system', '并发测试资金'
    )
  `,
    [testUser.user_id, amount],
  );

  console.log(`✅ 资金注入: $${amount}`);
  return result.rows[0];
}

async function testConcurrent() {
  console.log("🚀 开始场景3: 并发请求测试");

  await connectDatabases();

  try {
    // 1. 创建用户（使用完全相同的逻辑）
    await createTestUser();

    // 2. 注入1000美元
    await injectFunds(1000);

    console.log("⏳ 等待资金注入生效...");
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 3. 测试单个请求
    console.log("\n🔍 测试单个请求...");
    try {
      const response = await axios.post(
        `${API_BASE}/v1/chat/completions`,
        {
          messages: [{ role: "user", content: "测试消息" }],
          model: "qwen-turbo",
          provider: "dashscope",
        },
        {
          headers: {
            Authorization: `Bearer ${testUser.virtual_key}`,
            "Content-Type": "application/json",
          },
          timeout: 5000,
        },
      );
      console.log(`✅ 单请求成功: ${response.data.id}`);
    } catch (error) {
      console.log(`❌ 单请求失败: ${error.message}`);
      if (error.response) {
        console.log(`   状态码: ${error.response.status}`);
        console.log(`   响应: ${JSON.stringify(error.response.data)}`);
      }
      return;
    }

    // 4. 并发测试
    console.log("\n📡 发起10个并发请求...");
    const requests = [];
    const startTime = Date.now();

    for (let i = 0; i < 10; i++) {
      requests.push(
        axios
          .post(
            `${API_BASE}/v1/chat/completions`,
            {
              messages: [{ role: "user", content: `并发消息 ${i}` }],
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
          )
          .catch((err) => ({
            error: true,
            message: err.message,
            status: err.response?.status,
            data: err.response?.data,
          })),
      );
    }

    const results = await Promise.all(requests);
    const duration = Date.now() - startTime;

    // 统计
    const success = results.filter((r) => !r.error).length;
    const failed = results.filter((r) => r.error).length;

    console.log(`\n📊 结果:`);
    console.log(`   成功: ${success}`);
    console.log(`   失败: ${failed}`);
    console.log(`   耗时: ${duration}ms`);

    if (failed > 0) {
      console.log(`\n❌ 失败详情（前3个）:`);
      results
        .filter((r) => r.error)
        .slice(0, 3)
        .forEach((r, i) => {
          console.log(`   ${i + 1}. 状态码: ${r.status}, 错误: ${r.message}`);
        });
    }

    // 5. 等待异步处理
    console.log("\n⏳ 等待异步处理...");
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // 6. 简单验证
    const balance = await pgClient.query(
      `SELECT balance FROM data.account_balance WHERE owner_userid = $1`,
      [testUser.user_id],
    );

    const usage = await pgClient.query(
      `SELECT COUNT(*) as count FROM data.usage_log WHERE virtual_key = $1`,
      [testUser.virtual_key],
    );

    console.log(`\n🔍 验证:`);
    console.log(`   当前余额: ${balance.rows[0]?.balance}`);
    console.log(`   使用记录: ${usage.rows[0]?.count} 条`);

    console.log("\n" + "=".repeat(50));
    if (success >= 8) {
      // 允许少量失败
      console.log("✅ 并发测试基本通过");
    } else {
      console.log("❌ 并发测试失败");
    }
  } finally {
    await pgClient.release();
  }
}

// 运行
testConcurrent().catch(console.error);
