// tests/e2e/virtualKeyWorkflow.test.js
describe("Virtual Key Lifecycle Management", () => {
  test("Virtual Key generation and validation", async () => {
    // 创建 Virtual Key 类型
    const typeResponse = await request("http://localhost:3000")
      .post("/virtual_key_types")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        tenant_id: tenantId,
        type_name: "engineering",
        description: "Engineering team virtual keys",
        rate_limit_rpm: 2000,
        rate_limit_tpm: 200000,
        allowed_models: ["gpt-4", "gpt-3.5-turbo"],
        max_requests_per_month: 10000,
        cost_center: "ENG",
      });

    const keyTypeId = typeResponse.body.id;

    // 生成 Virtual Key
    const vkResponse = await request("http://localhost:3000")
      .post("/rpc/generate_virtual_key")
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        p_user_id: userId,
        p_key_type_id: keyTypeId,
        p_name: "Engineering Team Key",
        p_description: "For engineering team AI experiments",
      });

    const virtualKey = vkResponse.body;

    // 验证 Virtual Key 格式
    expect(virtualKey).toMatch(
      /^vk_[a-z]+_engineering_[a-f0-9]{8}_[a-f0-9]{4}$/,
    );

    // 使用 Virtual Key 调用服务
    const aiResponse = await request("http://localhost:3001")
      .post("/api/chat/completions")
      .set("x-virtual-key", virtualKey)
      .send({
        model: "gpt-4",
        messages: [{ role: "user", content: "Test message" }],
      });

    expect(aiResponse.status).toBe(200);
  });

  test("Virtual Key rotation", async () => {
    // 轮转 Virtual Key
    const rotateResponse = await request("http://localhost:3000")
      .post("/rpc/rotate_virtual_key")
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        p_old_virtual_key: virtualKey,
        p_reason: "quarterly_rotation",
      });

    const newVirtualKey = rotateResponse.body;

    // 验证旧密钥已停用
    const oldKeyCheck = await request("http://localhost:3000").get(
      `/virtual_keys?virtual_key=eq.${virtualKey}`,
    );

    expect(oldKeyCheck.body[0].is_active).toBe(false);

    // 验证新密钥可用
    const newKeyResponse = await request("http://localhost:3001")
      .post("/api/chat/completions")
      .set("x-virtual-key", newVirtualKey)
      .send({
        model: "gpt-4",
        messages: [{ role: "user", content: "Test with new key" }],
      });

    expect(newKeyResponse.status).toBe(200);
  });
});
