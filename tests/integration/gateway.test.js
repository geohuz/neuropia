// tests/integration/gateway.test.js
const request = require("supertest");
const { NeuropiaGateway } = require("../../neuropia_api_gateway/src/app");
const {
  RedisService,
} = require("../../neuropia_api_gateway/src/services/redisService");

describe("Neuropia API Gateway Integration Tests", () => {
  let gateway;
  let testVirtualKey = "vk_test_user_default_abc123def4_1a2b";
  let testUserId = "12345678-1234-1234-1234-123456789abc";

  beforeAll(async () => {
    // 启动网关服务
    gateway = new NeuropiaGateway();
    gateway.start(3001);

    // 初始化 Redis 连接
    await RedisService.connect();

    // 设置测试 Virtual Key
    await RedisService.cacheVirtualKey(testVirtualKey, {
      virtual_key: testVirtualKey,
      user_id: testUserId,
      name: "Test Virtual Key",
      rate_limit_rpm: 1000,
      rate_limit_tpm: 100000,
      allowed_models: ["gpt-3.5-turbo", "gpt-4"],
      is_active: true,
      tenant_id: "tenant-123",
    });
  });

  afterAll(async () => {
    if (gateway && gateway.server) {
      gateway.server.close();
    }
    if (RedisService.client) {
      await RedisService.client.quit();
    }
  });

  describe("Virtual Key Validation", () => {
    test("should validate valid virtual key", async () => {
      const response = await request("http://localhost:3001")
        .post("/api/config/virtual-keys/validate")
        .send({
          virtual_key: testVirtualKey,
          model: "gpt-3.5-turbo",
        });

      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(true);
      expect(response.body.virtual_key).toBe(testVirtualKey);
      expect(response.body.allowed_models).toContain("gpt-3.5-turbo");
    });

    test("should reject invalid virtual key", async () => {
      const response = await request("http://localhost:3001")
        .post("/api/config/virtual-keys/validate")
        .send({
          virtual_key: "invalid_key",
          model: "gpt-3.5-turbo",
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Invalid virtual key");
      expect(response.body.code).toBe("INVALID_VIRTUAL_KEY");
    });

    test("should reject disallowed model", async () => {
      const response = await request("http://localhost:3001")
        .post("/api/config/virtual-keys/validate")
        .send({
          virtual_key: testVirtualKey,
          model: "claude-2", // 不在允许列表中
        });

      expect(response.status).toBe(403);
      expect(response.body.error).toContain("Model not allowed");
      expect(response.body.code).toBe("MODEL_NOT_ALLOWED");
    });
  });

  describe("Configuration Endpoints", () => {
    test("should get virtual key configuration", async () => {
      const response = await request("http://localhost:3001").get(
        `/api/config/virtual-keys/${testVirtualKey}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.virtual_key).toBe(testVirtualKey);
      expect(response.body.name).toBe("Test Virtual Key");
      expect(response.body.rate_limits.rpm).toBe(1000);
      expect(response.body.rate_limits.tpm).toBe(100000);
    });

    test("should return 404 for non-existent virtual key", async () => {
      const response = await request("http://localhost:3001").get(
        "/api/config/virtual-keys/non_existent_key",
      );

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Virtual key not found");
    });

    test("should get system status", async () => {
      const response = await request("http://localhost:3001").get(
        "/api/config/status",
      );

      expect(response.status).toBe(200);
      expect(response.body.service).toBe("neuropia_api_gateway");
      expect(response.body.environment).toBeDefined();
      expect(response.body.redis).toBeDefined();
    });
  });

  describe("Error Handling", () => {
    test("should handle malformed requests", async () => {
      const response = await request("http://localhost:3001")
        .post("/api/config/virtual-keys/validate")
        .send({}); // 缺少 virtual_key

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Virtual key is required");
    });

    test("should handle internal server errors", async () => {
      // 模拟 Redis 连接失败
      const originalGet = RedisService.getVirtualKey;
      RedisService.getVirtualKey = jest
        .fn()
        .mockRejectedValue(new Error("Redis connection failed"));

      const response = await request("http://localhost:3001")
        .post("/api/config/virtual-keys/validate")
        .send({
          virtual_key: testVirtualKey,
        });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Validation failed");

      // 恢复原始函数
      RedisService.getVirtualKey = originalGet;
    });
  });
});
