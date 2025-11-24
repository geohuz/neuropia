// neuropia_api_gateway/src/routes/chat.js
const express = require('express');
const { BillingService } = require('../services/billingService');
const { ConfigService } = require('../services/configService');
const { RedisService } = require('../services/redisService');
const router = express.Router();

router.post('/completions', async (req, res) => {
    try {
        const { userContext } = req;
        const requestBody = req.body;

        // 1. 获取 Virtual Key 配置
        const virtualKeyConfig = await RedisService.getVirtualKey(userContext.virtual_key);
        if (!virtualKeyConfig) {
            return res.status(401).json({ error: 'Invalid virtual key' });
        }

        // 2. 预估成本
        const estimatedTokens = estimateTokenCount(requestBody.messages, requestBody.max_tokens);
        const estimatedCost = await BillingService.calculateCost(
            'dashscope', // 根据模型推断
            requestBody.model,
            estimatedTokens.input,
            estimatedTokens.output
        );

        // 3. 验证余额
        await BillingService.validateAndDeduct(userContext.user_id, estimatedCost);

        // 4. 从 Config Service 获取 Portkey 配置
        const portkeyConfig = await ConfigService.getPortkeyConfig(
            userContext,
            virtualKeyConfig,
            requestBody
        );

        // 5. 调用 Portkey Gateway
        const portkeyResponse = await callPortkeyGateway(portkeyConfig, requestBody);

        // 6. 记录实际使用量
        const actualUsage = extractUsageFromResponse(portkeyResponse);
        await BillingService.recordUsage({
            user_id: userContext.user_id,
            provider: inferProviderFromModel(requestBody.model),
            model: requestBody.model,
            input_tokens: actualUsage.prompt_tokens,
            output_tokens: actualUsage.completion_tokens,
            cost: await BillingService.calculateCost(
                inferProviderFromModel(requestBody.model),
                requestBody.model,
                actualUsage.prompt_tokens,
                actualUsage.completion_tokens
            ),
            prompt_hash: generatePromptHash(requestBody.messages)
        });

        res.json(portkeyResponse);
    } catch (error) {
        console.error('Chat completion error:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

// 辅助函数
function estimateTokenCount(messages, max_tokens) {
    const totalChars = messages.reduce((sum, msg) => sum + msg.content.length, 0);
    return {
        input: Math.ceil(totalChars / 4),
        output: max_tokens || 1000
    };
}

async function callPortkeyGateway(config, requestBody) {
    const response = await fetch(`${process.env.PORTKEY_GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-portkey-config': JSON.stringify(config),
            'x-portkey-provider': config.targets[0].provider
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        throw new Error(`Portkey Gateway error: ${response.statusText}`);
    }

    return response.json();
}

function extractUsageFromResponse(response) {
    return response.usage || { prompt_tokens: 0, completion_tokens: 0 };
}

function inferProviderFromModel(model) {
    if (model.includes('qwen')) return 'dashscope';
    if (model.includes('gpt')) return 'openai';
    if (model.includes('claude')) return 'anthropic';
    return 'dashscope'; // 默认
}

function generatePromptHash(messages) {
    // 简化的哈希生成
    return require('crypto')
        .createHash('md5')
        .update(JSON.stringify(messages))
        .digest('hex');
}

module.exports = router;
