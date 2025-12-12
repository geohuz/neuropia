const postgrest = require("@shared/clients/postgrest");
const RedisService = require("@shared/clients/redis_op");
// const schemaValidator = require("../validation/schemaValidator");
// const pricingCacheManager = require("./pricingCacheManager");
const CACHE_KEYS = require("../constants/cacheKeys");
const logger = require("@shared/utils/logger"); // 引入 logger

const CACHE_TTL = 24 * 60 * 60; // 86400秒

class ConfigService {
  /**
   * 获取完整配置（入口）
   */
  static async getAllConfigs(userContext, requestBody) {
    try {
      const { virtual_key } = userContext;
      logger.info("获取完整配置", { virtual_key });

      // ----------------------
      // 1. 获取 virtual_key 配置
      // ----------------------
      // 直接获取配置（数据库函数已包含所有验证）
      const computedConfig = await this.getVirtualKeyConfig(virtual_key);
      logger.info("配置获取完成");
      return computedConfig;
    } catch (error) {
      logger.error("配置获取失败", {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  /**
   * 获取 virtual_key 配置（带缓存）
   */
  static async getVirtualKeyConfig(virtualKey) {
    const cacheKey = CACHE_KEYS.VIRTUAL_KEY_CONFIG(virtualKey);

    // 1. 读取缓存
    const cached = await RedisService.kv.get(cacheKey);
    if (cached) {
      logger.debug("配置缓存命中", { virtualKey });
      return JSON.parse(cached);
    }

    // 2. 调用数据库 RPC 查询配置
    const { data, error } = await postgrest.rpc("get_virtualkey_config", {
      p_virtual_key: virtualKey,
    });
    if (error) {
      logger.error("数据库RPC调用失败", { virtualKey, error });
      throw error;
    }

    // 3. 注入 api_key（根据 provider）
    const configWithApiKeys = this.injectApiKeys(data);

    // 4. 写入缓存（TTL: 300 秒）
    await RedisService.kv.setex(
      cacheKey,
      CACHE_TTL,
      JSON.stringify(configWithApiKeys),
    );
    logger.info("配置缓存写入", { virtualKey });

    return configWithApiKeys;
  }

  /**
   * 降级配置（当上游不可用时）
   */
  static getFallbackConfig(userContext, requestBody) {
    logger.warn("使用降级配置", {
      virtual_key: userContext.virtual_key,
      model: requestBody.model,
    });

    return {
      strategy: {
        mode: "fallback",
      },
      targets: [
        {
          provider: "dashscope",
          override_params: {
            model: requestBody.model || "qwen-turbo",
            max_tokens: 2000,
          },
        },
      ],
      // metadata: schemaValidator.generateDefaultConfig(),
    };
  }

  /**
   * 遍历配置，为每个 target 注入 api_key
   */
  static injectApiKeys(config) {
    const providerKeys = {
      openai: process.env.OPENAI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      dashscope: process.env.DASHSCOPE_API_KEY,
      // 考虑添加更多provider
    };

    // 处理Portkey格式
    const portkeyConfig = config["x-portkey-config"] || config;

    function processObject(obj) {
      if (!obj || typeof obj !== "object") return obj;

      // 如果是target且有provider但没有api_key
      if (obj.provider && !obj.api_key) {
        const apiKey = providerKeys[obj.provider];
        if (apiKey) {
          return {
            ...obj,
            api_key: apiKey,
          };
        } else {
          logger.warn(`未找到 ${obj.provider} 的 API KEY`, {
            provider: obj.provider,
            availableProviders: Object.keys(providerKeys),
          });
        }
      }

      // 递归处理嵌套对象
      const result = { ...obj };
      for (const key in result) {
        if (Array.isArray(result[key])) {
          result[key] = result[key].map(processObject);
        } else if (result[key] && typeof result[key] === "object") {
          result[key] = processObject(result[key]);
        }
      }

      return result;
    }

    const processedConfig = processObject(portkeyConfig);

    // 如果是Portkey格式，恢复结构
    const finalConfig = config["x-portkey-config"]
      ? { ...config, "x-portkey-config": processedConfig }
      : processedConfig;

    logger.debug("API KEY 注入完成", {
      hasOpenAI: !!providerKeys.openai,
      hasAnthropic: !!providerKeys.anthropic,
      hasDashscope: !!providerKeys.dashscope,
    });

    return finalConfig;
  }
}

module.exports = {
  ConfigService,
};
