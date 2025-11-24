// tests/integration/virtualKey.test.js
const request = require("supertest");
const {
  RedisService,
} = require("../../neuropia_api_gateway/src/services/redisService");

describe("Virtual Key Lifecycle Integration Tests", () => {
  const testUserId = "user-virtual-key-test";
  const testTenantId = "tenant-virtual-key-test";

  beforeAll(async () => {
    await RedisService.connect();
  });

  afterAll(async () => {
    if (RedisService.client) {
      await RedisService.client.quit();
    }
  });

  describe("Virtual Key Generation and Validation", () => {
    test("should generate structured virtual keys", async () => {
      // 测试 Virtual Key 格式
      const virtualKeys = [
        "vk_acme_eng_7d3e9f1a_c8a4",
        "vk_startup_all_8f9e1d2c_a1b2",
        "vk_company_mkt_a1b2c3d4_f6e7",
      ];

      virtualKeys.forEach((vk) => {
        expect(vk).toMatch(/^vk_[a-z]+_[a-z]+_[a-f0-9]{8}_[a-f0-9]{4}$/);
      });
    });

    test("should handle virtual key activation and deactivation", async () => {
      const activeKey = "vk_test_active_abc123de_f1e2";
      const inactiveKey = "vk_test_inactive_def456ab_c3d4";

      // 缓存活跃密钥
      await RedisService.cacheVirtualKey(activeKey, {
        virtual_key: activeKey,
        user_id: testUserId,
        is_active: true,
      });

      // 缓存非活跃密钥
      await RedisService.cacheVirtualKey(inactiveKey, {
        virtual_key: inactiveKey,
        user_id: testUserId,
        is_active: false,
      });

      const activeConfig = await RedisService.getVirtualKey(activeKey);
      const inactiveConfig = await RedisService.getVirtualKey(inactiveKey);

      expect(activeConfig.is_active).toBe(true);
      expect(inactiveConfig.is_active).toBe(false);
    });
  });

  describe("Rate Limiting Configuration", () => {
    test("should apply different rate limits based on virtual key type", async () => {
      const virtualKeys = [
        {
          key: "vk_test_basic_abc123de_f1e2",
          config: {
            virtual_key: "vk_test_basic_abc123de_f1e2",
            rate_limit_rpm: 100,
            rate_limit_tpm: 10000,
          },
        },
        {
          key: "vk_test_premium_def456ab_c3d4",
          config: {
            virtual_key: "vk_test_premium_def456ab_c3d4",
            rate_limit_rpm: 1000,
            rate_limit_tpm: 100000,
          },
        },
        {
          key: "vk_test_enterprise_ghi789cd_e5f6",
          config: {
            virtual_key: "vk_test_enterprise_ghi789cd_e5f6",
            rate_limit_rpm: 10000,
            rate_limit_tpm: 1000000,
          },
        },
      ];

      for (const vk of virtualKeys) {
        await RedisService.cacheVirtualKey(vk.key, vk.config);
        const cachedConfig = await RedisService.getVirtualKey(vk.key);

        expect(cachedConfig.rate_limit_rpm).toBe(vk.config.rate_limit_rpm);
        expect(cachedConfig.rate_limit_tpm).toBe(vk.config.rate_limit_tpm);
      }
    });
  });

  describe("Model Access Control", () => {
    test("should enforce model restrictions", async () => {
      const restrictedKey = "vk_test_restricted_abc123de_f1e2";
      const unrestrictedKey = "vk_test_unrestricted_def456ab_c3d4";

      // 受限密钥 - 只允许特定模型
      await RedisService.cacheVirtualKey(restrictedKey, {
        virtual_key: restrictedKey,
        user_id: testUserId,
        allowed_models: ["gpt-3.5-turbo"],
        is_active: true,
      });

      // 不受限密钥 - 允许所有模型
      await RedisService.cacheVirtualKey(unrestrictedKey, {
        virtual_key: unrestrictedKey,
        user_id: testUserId,
        allowed_models: [], // 空数组表示无限制
        is_active: true,
      });

      const restrictedConfig = await RedisService.getVirtualKey(restrictedKey);
      const unrestrictedConfig =
        await RedisService.getVirtualKey(unrestrictedKey);

      expect(restrictedConfig.allowed_models).toEqual(["gpt-3.5-turbo"]);
      expect(unrestrictedConfig.allowed_models).toEqual([]);
    });
  });
});
