// neuropia_config_service/src/services/portkeyConfigGenerator.js
const postgrestClient = require("@shared/clients/postgrest");
const redisService = require("@shared/clients/redis");
const { configSchema } = require("@shared/utils/portkey_schema_config");
const { inferProviderFromModel } = require('@shared/utils/modelUtils');

class PortkeyConfigGenerator {
  static inferProvider(model) {
    return inferProviderFromModel(model);
  }

  static getRealApiKey(model) {
    const modelToKey = {
        // 阿里云百炼模型
        'qwen-turbo': process.env.DASHSCOPE_API_KEY,
        'qwen-plus': process.env.DASHSCOPE_API_KEY,
        'qwen-max': process.env.DASHSCOPE_API_KEY,
        'qwen-7b-chat': process.env.DASHSCOPE_API_KEY,
        'qwen-14b-chat': process.env.DASHSCOPE_API_KEY,

        // OpenAI 模型
        'gpt-3.5-turbo': process.env.OPENAI_API_KEY,
        'gpt-4': process.env.OPENAI_API_KEY,
        'gpt-4-turbo': process.env.OPENAI_API_KEY,

        // Anthropic 模型
        'claude-2': process.env.ANTHROPIC_API_KEY,
        'claude-3-sonnet': process.env.ANTHROPIC_API_KEY,
        'claude-3-opus': process.env.ANTHROPIC_API_KEY
    };

    const apiKey = modelToKey[model];
    return apiKey || process.env.DASHSCOPE_API_KEY; // 降级到阿里云
  }

static async generateConfig(userContext, virtualKeyConfig, requestBody) {
    try {
        const { user_id, virtual_key } = userContext;
        const safeRequestBody = requestBody || {};

        const configContext = {
            user_id,
            virtual_key,
            tier_name: userContext.tier_name,
            model: safeRequestBody.model,
            environment: process.env.NODE_ENV || "development",
            ...userContext,
        };

        // 解析动态配置
        const dynamicConfigs = await this.resolveAllConfigs(configContext);

        // 🎯 修复：使用正确的方法名
        let finalRequestBody = { ...safeRequestBody };
        if (!finalRequestBody.model) {
            const configuredModel = this.getDefaultModelFromConfig(dynamicConfigs); // 🎯 保持原名
            finalRequestBody.model = configuredModel;
            console.log(`🎯 使用配置中指定的模型: ${configuredModel}`);
        }

        console.log('✅ 完整配置准备完成:', {
            model: finalRequestBody.model,
            has_portkey_config: !!dynamicConfigs.portkey_config,
            has_rate_limits: !!dynamicConfigs.rate_limits,
            has_model_access: !!dynamicConfigs.model_access
        });

        const portkeyConfig = this.buildPortkeyConfig(
            dynamicConfigs,
            configContext,
            finalRequestBody,
        );

        const cacheKey = this.buildCacheKey(userContext, finalRequestBody);
        await redisService.setex(cacheKey, 300, JSON.stringify(portkeyConfig));

        return portkeyConfig;
    } catch (error) {
        console.error("❌ 配置生成失败:", error);
        throw new Error(`无法生成配置: ${error.message}`);
    }
}

// 🎯 确保这个方法存在且正确
static getDefaultModelFromConfig(dynamicConfigs) {
    console.log("dynamicCOnfig", JSON.stringify(dynamicConfigs))
    console.log('🔍 正在从配置中获取模型...', Object.keys(dynamicConfigs || {}));

    // 1. 首先检查 portkey_config 的 targets 中指定的模型
    const portkeyConfig = dynamicConfigs?.portkey_config;
    console.log('📦 portkey_config:', portkeyConfig);

    if (portkeyConfig?.targets?.[0]?.override_params?.model) {
        const model = portkeyConfig.targets[0].override_params.model;
        console.log(`🎯 从 portkey_config 获取模型: ${model}`);
        return model;
    }

    // 2. 检查 model_access 中允许的第一个模型
    const modelAccess = dynamicConfigs?.model_access;
    console.log('📦 model_access:', modelAccess);

    if (modelAccess?.allowed_models?.[0]) {
        const model = modelAccess.allowed_models[0];
        console.log(`🎯 从 model_access 获取模型: ${model}`);
        return model;
    }

    // 🎯 如果配置系统真的没有配置模型，抛出明确错误
    console.error('❌ 配置系统中未找到模型配置');
    throw new Error('配置系统中未找到模型配置，请检查 virtual_key 配置');
}

  static buildCacheKey(userContext, requestBody) {
    const { user_id, virtual_key, tier_name } = userContext;
    const { model } = requestBody;
    return ["portkey_config", user_id, virtual_key, tier_name || "default", model || "default"].join(":");
  }

  static async resolveAllConfigs(context) {
    // 🎯 更新配置类型名称
    const configTypes = ["portkey_config", "rate_limits"]; // 🎯 只保留这两个

    const configs = {};
    for (const configType of configTypes) {
        try {
            const configCacheKey = `config_resolution:${configType}:${context.virtual_key}:${context.tier_name || 'default'}`;
            const cachedConfig = await redisService.get(configCacheKey);

            if (cachedConfig) {
                configs[configType] = JSON.parse(cachedConfig);
                continue;
            }

            configs[configType] = await this.resolveDynamicConfig(
                configType,
                "virtual_key",
                context.virtual_key,
                context
            );

            await redisService.setex(configCacheKey, 600, JSON.stringify(configs[configType]));

        } catch (error) {
            console.warn(`⚠️ Failed to resolve ${configType}, using default`);
            configs[configType] = this.getDefaultConfig(configType);
        }
    }
    return configs;
  }

  static async resolveDynamicConfig(configType, targetLevel, scopeId, context) {
    const response = await postgrestClient
        .rpc('resolve_dynamic_config', {
            p_config_type: configType,
            p_target_level: targetLevel,
            p_target_scope_id: scopeId,
            p_context: context
        });

    if (response.error) {
        throw new Error(`RPC错误: ${response.error.message}`);
    }

    return response.data || this.getDefaultConfig(configType);
  }

  // 🎯 简化的默认配置
  static getDefaultConfig(configType) {
    const defaults = {
      portkey_config: {
        strategy_mode: 'fallback',
        retry_attempts: 3,
        retry_status_codes: [429, 500, 502, 503]
      },
      rate_limits: {
        max_tokens: 2000,
        requests_per_minute: 60
      }
    };
    return defaults[configType] || {};
  }

  static buildPortkeyConfig(dynamicConfigs, context, requestBody) {
    const { model, temperature = 0.7, top_p = 0.8 } = requestBody || {};
    // 🎯 修复：确保 requestBody 有 model
    if (!requestBody?.model) {
        throw new Error('❌ requestBody缺少model字段，请在调用前确保设置model');
    }

    const provider = this.inferProvider(model);
    const apiKey = this.getRealApiKey(model);
    if (!provider || !apiKey) throw new Error(`❌ 无效model: ${model}`);

    const portkeyConfig = dynamicConfigs?.portkey_config || {};
    const rateLimits = dynamicConfigs?.rate_limits || {};

    // 🎯 验证配置
    const result = configSchema(portkeyConfig);
    if (!result.success) {
      // 获取详细错误信息
      console.log("验证失败:");
      result.error.issues.forEach((issue) => {
        console.log(`路径: ${issue.path.join(".")}`);
        console.log(`消息: ${issue.message}`);
        console.log("---");
      });
    } else {
      console.log("验证成功:", result.data);
    }

    const {
        strategy_mode = "fallback",
        retry_attempts = 0,
        retry_status_codes = [429, 500, 502, 503],
        cache = {},
        request_timeout,
        targets: configTargets = []
    } = portkeyConfig;

    // 🎯 构建 targets
    const targets = configTargets.length > 0
        ? configTargets.map(target => ({
            provider: target.provider || provider,
            weight: target.weight || 1,
            api_key: target.api_key || apiKey,
            override_params: {
                model: target.model || model,
                max_tokens: target.max_tokens || rateLimits.max_tokens || 2000,
                temperature: target.temperature || temperature,
                top_p: target.top_p || top_p
            }
        }))
        : [{
            provider,
            weight: 1,
            api_key: apiKey,
            override_params: { model, max_tokens: rateLimits.max_tokens || 2000, temperature, top_p }
        }];

    // 🎯 构建最终配置
    const finalPortkeyConfig = {
        strategy: { mode: strategy_mode },
        targets,
        retry: { attempts: retry_attempts, on_status_codes: retry_status_codes },
        ...(cache.enabled && { cache: { mode: cache.mode || "simple", max_age: cache.max_age || 300 } }),
        ...(request_timeout && { request_timeout }),
        metadata: {
            user_id: context.user_id,
            virtual_key: context.virtual_key,
            tier_name: context.tier_name,
            environment: process.env.NODE_ENV || 'development',
            resolved_at: new Date().toISOString(),
            config_source: 'neuropia_dynamic_config'
        }
    };

    return { apikey: apiKey, ...finalPortkeyConfig };
  }

  // 🎯 保留必要的工具方法
  static async getFallbackConfig(userContext, requestBody) {
    // 简化的降级配置逻辑
    return {
        strategy: { mode: "fallback" },
        targets: [{
            provider: this.inferProvider(requestBody.model),
            override_params: {
                model: requestBody.model,
                max_tokens: 2000,
                temperature: 0.7,
            }
        }],
        metadata: {
            user_id: userContext.user_id,
            config_source: "fallback",
        }
    };
  }

  static async clearConfigCache(userContext, requestBody) {
    const cacheKey = this.buildCacheKey(userContext, requestBody);
    await redisService.del(cacheKey);
  }
}

module.exports = { PortkeyConfigGenerator };
