// tests/e2e/fullWorkflow.test.js
const request = require("supertest");
const { NeuropiaGateway } = require("../../neuropia_api_gateway/src/app");
const {
  ConfigManager,
} = require("../../neuropia_config_service/src/services/configManager");

describe("Neuropia Platform E2E Workflow", () => {
  let gateway;
  let adminToken;
  let userToken;
  let virtualKey;
  let userId;

  beforeAll(async () => {
    // 启动服务
    gateway = new NeuropiaGateway();
    gateway.start(3001);

    // 加载配置
    await ConfigManager.loadAllConfigs();
  });

  afterAll(async () => {
    gateway.server.close();
  });

  test("Complete user lifecycle and AI call workflow", async () => {
    // 1. 管理员登录
    const adminLogin = await request("http://localhost:3000") // PostgREST
      .post("/rpc/login")
      .send({ email: "api@neuropia", pass: "api" });

    adminToken = adminLogin.body.token;

    // 2. 注册新用户
    const registerResponse = await request("http://localhost:3000")
      .post("/rpc/register_user")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        p_email: "testuser@neuropia.com",
        p_username: "testuser",
        p_password: "testpass123",
      });

    userId = registerResponse.body;

    // 3. 用户登录
    const userLogin = await request("http://localhost:3000")
      .post("/rpc/login")
      .send({
        email: "testuser@neuropia.com",
        pass: "testpass123",
      });

    userToken = userLogin.body.token;

    // 4. 检查用户访问权限（应该是 pending 状态）
    const accessCheck = await request("http://localhost:3000")
      .post("/rpc/check_user_access")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ p_user_id: userId });

    expect(accessCheck.body.user_status).toBe("pending");
    expect(accessCheck.body.can_use_api).toBe(false);

    // 5. 用户充值
    const topupResponse = await request("http://localhost:3000")
      .post("/rpc/topup_user")
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        p_user_id: userId,
        p_amount: 100,
        p_payment_reference: "test_ref_001",
        p_payment_provider: "test_provider",
      });

    const topupId = topupResponse.body;

    // 6. 确认充值
    await request("http://localhost:3000")
      .post("/rpc/confirm_topup")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ p_topup_id: topupId });

    // 7. 再次检查用户状态（应该是 active）
    const accessCheck2 = await request("http://localhost:3000")
      .post("/rpc/check_user_access")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ p_user_id: userId });

    expect(accessCheck2.body.user_status).toBe("active");
    expect(accessCheck2.body.can_use_api).toBe(true);

    // 8. 创建虚拟密钥
    const vkResponse = await request("http://localhost:3000")
      .post("/rpc/create_virtual_key")
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        p_user_id: userId,
        p_name: "Test Virtual Key",
        p_description: "For testing purposes",
        p_rate_limit_rpm: 1000,
        p_rate_limit_tpm: 100000,
        p_allowed_models: ["gpt-3.5-turbo", "gpt-4"],
      });

    virtualKey = vkResponse.body;

    // 9. 创建 Portkey 配置
    const configResponse = await request("http://localhost:3000")
      .post("/rpc/create_portkey_config")
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        p_tenant_id: null,
        p_user_id: userId,
        p_config_name: "Test Config",
        p_config_json: {
          strategy: {
            mode: "fallback",
            on_status_codes: [429, 500, 502, 503],
          },
          targets: [
            {
              provider: "openai",
              virtual_key: virtualKey,
              override_params: {
                model: "gpt-3.5-turbo",
              },
            },
          ],
        },
        p_effective_from: new Date().toISOString(),
        p_notes: "Test configuration",
        p_created_by: userId,
      });

    const configId = configResponse.body;

    // 10. 通过业务网关调用 AI 服务
    const aiResponse = await request("http://localhost:3001")
      .post("/api/chat/completions")
      .set("x-virtual-key", virtualKey)
      .send({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: "Hello, world!" }],
        max_tokens: 100,
      });

    expect(aiResponse.status).toBe(200);
    expect(aiResponse.body.choices).toBeDefined();

    // 11. 验证使用记录
    const usageLogs = await request("http://localhost:3000")
      .get("/usage_logs")
      .set("Authorization", `Bearer ${userToken}`)
      .query({ user_id: `eq.${userId}` });

    expect(usageLogs.body.length).toBeGreaterThan(0);

    // 12. 验证余额变化
    const balance = await request("http://localhost:3000")
      .get("/account_balances")
      .set("Authorization", `Bearer ${userToken}`)
      .query({ user_id: `eq.${userId}` });

    expect(parseFloat(balance.body[0].balance)).toBeLessThan(100);
  });

  test("Virtual key validation and rate limiting", async () => {
    // 测试无效虚拟密钥
    const invalidResponse = await request("http://localhost:3001")
      .post("/api/chat/completions")
      .set("x-virtual-key", "invalid_key")
      .send({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: "Test" }],
      });

    expect(invalidResponse.status).toBe(401);

    // 测试模型权限
    const wrongModelResponse = await request("http://localhost:3001")
      .post("/api/chat/completions")
      .set("x-virtual-key", virtualKey)
      .send({
        model: "claude-2", // 不在允许列表中
        messages: [{ role: "user", content: "Test" }],
      });

    expect(wrongModelResponse.status).toBe(403);
  });
});
