// neuropia_api_gateway/src/services/billingService.js
const { RedisService } = require('./redisService');
const postgrestClient = require('../clients/postgrest');

class BillingService {
    static async calculateCost(provider, model, inputTokens, outputTokens, requests = 1) {
        try {
            // 从 Redis 获取最新费率
            const rates = await RedisService.getProviderRates();
            const rate = rates.find(r => r.provider === provider && r.model === model);

            if (!rate) {
                throw new Error(`Rate not found for ${provider}/${model}`);
            }

            let cost = 0;

            switch(rate.pricing_model) {
                case 'per_token':
                    cost = (inputTokens * rate.price_per_input_token) +
                           (outputTokens * rate.price_per_output_token);
                    break;

                case 'per_request':
                    cost = requests * rate.price_per_request;
                    break;

                case 'hybrid':
                    cost = (inputTokens * rate.price_per_input_token) +
                           (outputTokens * rate.price_per_output_token) +
                           (requests * rate.price_per_request);
                    break;

                default:
                    // 默认按 token 计费
                    cost = (inputTokens * rate.price_per_input_token) +
                           (outputTokens * rate.price_per_output_token);
            }

            // 转换为平台货币（如 RMB）
            cost = await this.convertCurrency(cost, rate.currency, 'CNY');

            return Math.max(cost, 0.0001); // 最小成本
        } catch (error) {
            console.error('Cost calculation error:', error);
            throw error;
        }
    }

    static async convertCurrency(amount, fromCurrency, toCurrency) {
        // 简化版本 - 实际应调用汇率 API
        const rates = {
            'USD_CNY': 7.2,
            'EUR_CNY': 7.8,
            'GBP_CNY': 9.1
        };

        if (fromCurrency === toCurrency) return amount;

        const rateKey = `${fromCurrency}_${toCurrency}`;
        const rate = rates[rateKey] || 1;

        return amount * rate;
    }

    static async validateAndDeduct(userId, estimatedCost) {
        try {
            // 检查用户余额
            const balanceResponse = await postgrestClient.get(
                `/account_balances?user_id=eq.${userId}`
            );

            if (!balanceResponse.data || balanceResponse.data.length === 0) {
                throw new Error('User balance not found');
            }

            const currentBalance = parseFloat(balanceResponse.data[0].balance);

            if (currentBalance < estimatedCost) {
                throw new Error('Insufficient balance');
            }

            return true;
        } catch (error) {
            console.error('Balance validation error:', error);
            throw error;
        }
    }

    static async recordUsage(usageData) {
        try {
            const response = await postgrestClient.post('/rpc/record_usage', {
                p_user_id: usageData.user_id,
                p_provider: usageData.provider,
                p_model: usageData.model,
                p_input_tokens: usageData.input_tokens,
                p_output_tokens: usageData.output_tokens,
                p_cost: usageData.cost,
                p_prompt_hash: usageData.prompt_hash
            });

            return response.data;
        } catch (error) {
            console.error('Usage recording error:', error);
            throw error;
        }
    }
}
