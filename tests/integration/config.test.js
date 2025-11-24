// tests/integration/config.test.js
const request = require("supertest");
const {
  ConfigManager,
} = require("../../neuropia_config_service/src/services/configManager");
const {
  RedisService,
} = require("../../neuropia_config_service/src/services/redisService");

describe("Neuropia Config Service Integration Tests", () => {
  beforeAll(async () => {
    // 初始化 Redis 连接
    await RedisService.connect();
  });

  afterAll(async () => {
    if (RedisService.client) {
      await RedisService.client.quit();
    }
  });

  describe("Configuration Management", () => {
    test("should cache virtual key configuration", async () => {
      const testVirtualKey = "vk_test_cache_abc123def4_1a2b";
      const testConfig = {
        virtual_key: testVirtualKey,
        user_id: "user-123",
        name: "Cached Virtual Key",
        rate_limit_rpm: 500,
        rate_limit_tpm: 50000,
        allowed_models: ["gpt-3.5-turbo"],
        is_active: true,
      };

      await RedisService.cacheVirtualKey(testVirtualKey, testConfig);

      const cachedConfig = await RedisService.getVirtualKey(testVirtualKey);

      expect(cachedConfig).toEqual(testConfig);
    });

    test("should handle configuration updates", async () => {
      const configId = "config-123";
      const testConfig = {
        id: configId,
        config_name: "Test Config",
        config_json: {
          strategy: { mode: "fallback" },
          targets: [],
        },
      };

      await RedisService.cachePortkeyConfig(
        `portkey_config:${configId}`,
        testConfig,
      );

      const cachedConfig = await RedisService.getPortkeyConfig(
        `portkey_config:${configId}`,
      );

      expect(cachedConfig.id).toBe(configId);
      expect(cachedConfig.config_name).toBe("Test Config");
    });
  });

  describe("Provider Rates Management", () => {
    test("should cache and retrieve provider rates", async () => {
      const testRates = [
        {
          provider: "openai",
          model: "gpt-3.5-turbo",
          price_per_input_token: 0.0015,
          price_per_output_token: 0.002,
          pricing_model: "per_token",
          currency: "usd",
        },
        {
          provider: "anthropic",
          model: "claude-2",
          price_per_input_token: 0.008,
          price_per_output_token: 0.024,
          pricing_model: "per_token",
          currency: "usd",
        },
      ];

      await RedisService.cacheProviderRates(testRates);

      const cachedRates = await RedisService.getProviderRates();

      expect(cachedRates).toHaveLength(2);
      expect(cachedRates[0].provider).toBe("openai");
      expect(cachedRates[1].provider).toBe("anthropic");
    });
  });

  describe("Usage Tracking", () => {
    test("should increment virtual key usage", async () => {
      const testVirtualKey = "vk_test_usage_abc123def4_1a2b";

      await RedisService.incrementVirtualKeyUsage(testVirtualKey, 150);

      // 由于 Redis 哈希操作，我们需要直接检查 Redis
      const usageKey = `usage:${testVirtualKey}`;
      const usageData = await RedisService.client.hGetAll(usageKey);

      expect(parseInt(usageData.request_count)).toBe(1);
      expect(parseInt(usageData.token_count)).toBe(150);
      expect(usageData.last_used).toBeDefined();
    });

    test("should handle multiple usage increments", async () => {
      const testVirtualKey = "vk_test_multi_usage_abc123def4_1a2b";

      await RedisService.incrementVirtualKeyUsage(testVirtualKey, 100);
      await RedisService.incrementVirtualKeyUsage(testVirtualKey, 200);

      const usageKey = `usage:${testVirtualKey}`;
      const usageData = await RedisService.client.hGetAll(usageKey);

      expect(parseInt(usageData.request_count)).toBe(2);
      expect(parseInt(usageData.token_count)).toBe(300);
    });
  });
});
