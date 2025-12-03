// neuropia_api_gateway/src/services/configService.js
const postgrest = require('../clients/postgrest');
const RedisService = require('@shared/clients/redis_op');
const schemaValidator = require('../validation/schemaValidator');
const pricingCacheManager = require('./pricingCacheManager');
const CACHE_KEYS = require('../constants/cacheKeys');

class ConfigService {
  /**
   * 获取完整配置（入口）
   */
  static async getAllConfigs(userContext, requestBody) {
    try {
      const { virtual_key } = userContext;
      console.log('获取完整配置:', { virtual_key });

      // ----------------------
      // 1. 获取 virtual_key 配置
      // ----------------------
      // 直接获取配置（数据库函数已包含所有验证）
      const computedConfig = await this.getVirtualKeyConfig(virtual_key);
      // 验证和补全 metadata
      const validatedConfig = this.validateMetadata(computedConfig);

      console.log('配置获取完成');
      return validatedConfig
    } catch (error) {
      console.error('配置获取失败:', error);
      throw error;
    }
  }

  /**
   * 获取 virtual_key 配置（带缓存）
   */
  static async getVirtualKeyConfig(virtualKey) {
    const cacheKey = CACHE_KEYS.VIRTUAL_KEY_CONFIG(virtualKey);

    // ----------------------
    // 1. 读取缓存
    // ----------------------
    const cached = await RedisService.kv.get(cacheKey);
    if (cached) {
      console.log('配置缓存命中:', virtualKey);
      return JSON.parse(cached);
    }

    // ----------------------
    // 2. 调用数据库 RPC 查询配置
    // ----------------------
    const { data, error } = await postgrest.rpc('get_virtualkey_config', {
      p_virtual_key: virtualKey
    });
    if (error) throw error;

    // ----------------------
    // 3. 注入 api_key（根据 provider）
    // ----------------------
    const configWithApiKeys = this.injectApiKeys(data);

    // ----------------------
    // 4. 写入缓存（TTL: 300 秒）
    // ----------------------
    await RedisService.kv.setex(cacheKey, 300, JSON.stringify(configWithApiKeys));
    console.log('配置缓存写入:', virtualKey);

    return configWithApiKeys;
  }

  /**
   * 验证和补全 metadata
   */
  static validateMetadata(computedConfig) {
    if (!computedConfig.metadata) {
      computedConfig.metadata = schemaValidator.generateDefaultConfig();
    } else {
      computedConfig.metadata = schemaValidator.validateComplete(
        computedConfig.metadata
      );
    }
    return computedConfig;
  }

  /**
   * 降级配置（当上游不可用时）
   */
  static getFallbackConfig(userContext, requestBody) {
    console.warn('使用降级配置');

    return {
      strategy: {
        mode: "fallback"
      },
      targets: [
        {
          provider: "dashscope",
          override_params: {
            model: requestBody.model || "qwen-turbo",
            max_tokens: 2000
          }
        }
      ],
      metadata: schemaValidator.generateDefaultConfig()
    };
  }

  /**
   * 遍历配置，为每个 target 注入 api_key
   */
  static injectApiKeys(config) {
    const providerKeys = {
      openai: process.env.OPENAI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      dashscope: process.env.DASHSCOPE_API_KEY
    };

    function processTargets(targets) {
      return targets.map(target => {
        // 递归处理嵌套 targets
        if (target.targets) {
          return {
            ...target,
            targets: processTargets(target.targets)
          };
        }

        // 为没有 api_key 的 target 注入
        if (target.provider && !target.api_key) {
          return {
            ...target,
            api_key: providerKeys[target.provider]
          };
        }

        return target;
      });
    }

    return {
      ...config,
      targets: processTargets(config.targets || [])
    };
  }
}

module.exports = {
  ConfigService
};
