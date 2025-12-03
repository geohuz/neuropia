const BalanceService = require('./balanceService');

/**
 * 计算请求消耗并扣费
 * @param virtual_key {string}
 * @param usage {object} 包含 tokens 消耗，如 { total_tokens, prompt_tokens, completion_tokens }
 * @param priceConfig {object} 可选，计算 cost
 */
async function deductCost(virtual_key, usage, priceConfig = { perToken: 0.0001 }) {
    const cost = (usage?.total_tokens || 1) * priceConfig.perToken;

    const result = await BalanceService.chargeUser(virtual_key, cost);

    if (result.err) {
        console.error(`💳 扣费失败: ${result.err}`);
        throw new Error(result.err);
    }

    console.log(`💳 已扣费 ${cost}, 新余额 = ${result.ok}`);
    return result.ok;
}

module.exports = { deductCost };
