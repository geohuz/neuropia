// neuropia_config_service/src/services/portkeyConfigGenerator.js
const { RedisService } = require('./redisService');

class PortkeyConfigGenerator {
    /**
     * 为指定用户和模型生成 Portkey 配置
     */
    static async generateConfig(userContext, virtualKeyConfig, requestBody) {
        const requestedModel = requestBody.model;

        // 获取模型配置
        const modelConfig = await this.getModelConfig(requestedModel);
        if (!modelConfig) {
            throw new Error(`Unsupported model: ${requestedModel}`);
        }

        const baseConfig = {
            strategy: {
                mode: "fallback",
                on_status_codes: [429, 500, 502, 503]
            },
            targets: [{
                provider: modelConfig.provider,
                virtual_key: virtualKeyConfig.virtual_key,
                api_key: this.getProviderApiKey(modelConfig.provider),
                override_params: {
                    model: modelConfig.portkey_target_name || requestedModel,
                    max_tokens: this.calculateMaxTokens(userContext, virtualKeyConfig, modelConfig),
                    temperature: this.calculateTemperature(userContext, requestedModel)
                },
                retry: {
                    attempts: 3,
                    on_status_codes: [429, 500, 502, 503],
                    backoff_strategy: "exponential"
                },
                metadata: {
                    user_id: userContext.user_id,
                    tenant_id: userContext.tenant_id,
                    cost_tier: virtualKeyConfig.cost_tier || 'standard'
                }
            }],
            cache: {
                mode: "semantic",
                max_age: 3600
            },
            metadata: {
                user_id: userContext.user_id,
                tenant_id: userContext.tenant_id,
                virtual_key: userContext.virtual_key,
                request_id: userContext.request_id,
                environment: process.env.NODE_ENV || 'development'
            }
        };

        return baseConfig;
    }

    /**
     * 从 Redis 或数据库获取模型配置
     */
    static async getModelConfig(modelName) {
        // 首先尝试从 Redis 缓存获取
        const cachedModel = await RedisService.getProviderModel(modelName);
        if (cachedModel) {
            return cachedModel;
        }

        // 如果缓存中没有，从数据库获取所有模型配置并缓存
        const allModels = await this.loadAllModelConfigs();
        return allModels[modelName] || null;
    }

    /**
     * 从数据库加载所有模型配置到 Redis
     */
    static async loadAllModelConfigs() {
        try {
            const response = await fetch(
                `${process.env.POSTGREST_URL}/model_configs_view`
            );

            if (!response.ok) {
                throw new Error(`Failed to fetch model configs: ${response.statusText}`);
            }

            const modelConfigs = await response.json();

            // 转换为字典格式
            const modelMap = {};
            modelConfigs.forEach(config => {
                modelMap[config.model_name] = config;
            });

            // 缓存到 Redis
            await RedisService.cacheProviderModels(modelMap);

            return modelMap;
        } catch (error) {
            console.error('Error loading model configs:', error);
            return {};
        }
    }

    static getProviderApiKey(provider) {
        const apiKeys = {
            'dashscope': process.env.DASHSCOPE_API_KEY,
            'openai': process.env.OPENAI_API_KEY,
            'anthropic': process.env.ANTHROPIC_API_KEY
        };
        return apiKeys[provider];
    }

    static calculateMaxTokens(userContext, virtualKeyConfig, modelConfig) {
        const baseTokens = modelConfig.max_tokens || 2000;
        const tierMultiplier = {
            'standard': 1,
            'premium': 2,
            'enterprise': 4
        };

        const calculatedTokens = baseTokens * (tierMultiplier[virtualKeyConfig.cost_tier] || 1);
        return Math.min(calculatedTokens, modelConfig.context_length || 4000);
    }

    static calculateTemperature(userContext, model) {
        const defaultTemps = {
            'qwen-turbo': 0.8,
            'qwen-plus': 0.7,
            'qwen-max': 0.6,
            'gpt-4': 0.3,
            'gpt-3.5-turbo': 0.7
        };
        return defaultTemps[model] || 0.7;
    }
}

module.exports = { PortkeyConfigGenerator };
