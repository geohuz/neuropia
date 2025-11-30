const Redis = require('@shared/clients/redis_op');
const REDIS_SCHEMA = require('@shared/clients/redisSchema');

/** --- Redis 原始数据读取 --- */
async function getMonitoringStream(streamKey = Redis.schema.STREAMS.API_MONITORING_STREAM, count = 10) {
    const client = await Redis.connect();
    const actualStreamKey = typeof streamKey === 'string' ? streamKey : Redis.schema.STREAMS.API_MONITORING_STREAM;

    const messages = await client.xRevRange(actualStreamKey, '+', '-', { COUNT: count });
    messages.reverse();

    return messages.map(msg => {
        const fields = msg.message;
        const record = {
            id: msg.id,
            virtual_key: fields.virtual_key,
            path: fields.path,
            model: fields.model,
            method: fields.method,
            timestamp: fields.timestamp
        };
        try {
            if (fields.usage) record.usage = JSON.parse(fields.usage);
            if (fields.performance) record.performance = JSON.parse(fields.performance);
            if (fields.provider_info) record.provider_info = JSON.parse(fields.provider_info);
            if (fields.tracing) record.tracing = JSON.parse(fields.tracing);
        } catch (err) {
            console.warn('JSON解析失败:', err);
        }
        return record;
    });
}

/** --- 虚拟键统计 --- */
async function getVirtualKeyStats(virtualKey) {
    if (!virtualKey) return null;
    const client = await Redis.connect();
    const key = REDIS_SCHEMA.buildKey(Redis.schema.HASHES.VIRTUAL_KEY_USAGE.pattern, { virtual_key: virtualKey });
    const stats = await client.hGetAll(key);

    if (!stats || Object.keys(stats).length === 0) {
        return {
            virtual_key: virtualKey,
            request_count: 0,
            total_tokens: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            cached_tokens: 0,
            last_used: '从未使用'
        };
    }

    return {
        virtual_key: virtualKey,
        request_count: parseInt(stats.request_count) || 0,
        total_tokens: parseInt(stats.total_tokens) || 0,
        prompt_tokens: parseInt(stats.prompt_tokens) || 0,
        completion_tokens: parseInt(stats.completion_tokens) || 0,
        cached_tokens: parseInt(stats.cached_tokens) || 0,
        last_used: stats.last_used || '从未使用'
    };
}

/** --- 提供商统计 --- */
async function getProviderStats(provider) {
    if (!provider) return null;
    const client = await Redis.connect();
    const key = REDIS_SCHEMA.buildKey(Redis.schema.HASHES.PROVIDER_STATS.pattern, { provider });
    const stats = await client.hGetAll(key);
    const date = new Date().toISOString().split('T')[0];

    return {
        provider,
        total_requests: parseInt(stats.total_requests) || 0,
        total_tokens: parseInt(stats.total_tokens) || 0,
        cache_hits: parseInt(stats.cache_hits) || 0,
        total_retries: parseInt(stats.total_retries) || 0,
        daily_requests: parseInt(stats[`daily:${date}:requests`]) || 0,
        daily_tokens: parseInt(stats[`daily:${date}:tokens`]) || 0
    };
}

/** --- Top N 虚拟键 --- */
async function getTopVirtualKeys(limit = 10) {
    const client = await Redis.connect();
    const zsetKey = Redis.schema.SORTED_SETS.VIRTUAL_KEY_TOTAL_TOKENS;
    const ranked = await client.zRangeWithScores(zsetKey, 0, limit - 1, { REV: true });

    const stats = await Promise.all(ranked.map(({ value }) => getVirtualKeyStats(value)));
    return stats.filter(Boolean);
}

/** --- Top N 提供商 --- */
async function getTopProviders(limit = 10) {
    const client = await Redis.connect();
    const zsetKey = Redis.schema.SORTED_SETS.PROVIDER_TOTAL_TOKENS;
    const ranked = await client.zRangeWithScores(zsetKey, 0, limit - 1, { REV: true });

    return ranked.map(({ value, score }) => ({ value, score }));
}

/** --- 缓存统计 --- */
async function getCacheStats() {
    const records = await getMonitoringStream(Redis.schema.STREAMS.API_MONITORING_STREAM, 100);
    const totalRequests = records.length;
    const cacheHits = records.filter(r => r.performance?.cache_status === 'HIT').length;

    return {
        total_requests: totalRequests,
        cache_hits: cacheHits,
        cache_misses: totalRequests - cacheHits,
        hit_rate: totalRequests > 0 ? ((cacheHits / totalRequests) * 100).toFixed(2) + '%' : '0%'
    };
}

/** --- 错误统计 --- */
async function getErrorStats() {
    const client = await Redis.connect();
    const errorKeys = await client.keys('errors:*');
    const errorStats = {};

    for (const key of errorKeys) {
        const virtualKey = key.replace('errors:', '');
        const errors = await client.hGetAll(key);
        const filtered = Object.fromEntries(
            Object.entries(errors).filter(([_, count]) => parseInt(count) > 0)
        );
        if (Object.keys(filtered).length > 0) errorStats[virtualKey] = filtered;
    }
    return errorStats;
}

/** --- 成本统计 --- */
async function getCostStats() {
    const client = await Redis.connect();
    const costKeys = await client.keys('user_costs:*');
    const costs = [];

    for (const key of costKeys) {
        const virtualKey = key.replace('user_costs:', '');
        const stats = await client.hGetAll(key);

        const totalTokens = parseInt(stats.total_tokens) || 0;
        if (totalTokens === 0) continue;

        const estimatedCost = totalTokens * 0.000002;
        costs.push({
            virtual_key: virtualKey,
            total_requests: parseInt(stats.total_requests) || 0,
            total_tokens: totalTokens,
            prompt_tokens: parseInt(stats.prompt_tokens) || 0,
            completion_tokens: parseInt(stats.completion_tokens) || 0,
            estimated_cost: estimatedCost.toFixed(6),
            last_updated: stats.last_updated || '未知'
        });
    }

    costs.sort((a, b) => parseFloat(b.estimated_cost) - parseFloat(a.estimated_cost));
    const totalEstimatedCost = costs.reduce((sum, c) => sum + parseFloat(c.estimated_cost), 0).toFixed(6);

    return { costs, total_users: costs.length, total_estimated_cost: totalEstimatedCost };
}

module.exports = {
    getMonitoringStream,
    getVirtualKeyStats,
    getProviderStats,
    getTopVirtualKeys,
    getTopProviders,
    getCacheStats,
    getErrorStats,
    getCostStats
};
