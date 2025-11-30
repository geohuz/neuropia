// src/services/analyticsService.js
const Redis = require('@shared/clients/redis_op');

/**
 * 从Redis Stream读取原始监控数据
 */
async function getMonitoringStream(streamKey = Redis.schema.STREAMS.API_MONITORING_STREAM, count = 10) {
    try {
        const client = await Redis.connect();

        // 处理字符串参数的情况（从路由传递过来的）
        const actualStreamKey = typeof streamKey === 'string'
            ? streamKey
            : Redis.schema.STREAMS.API_MONITORING_STREAM;


        const messages = await client.xRevRange(actualStreamKey, '+', '-', { COUNT: count });
        messages.reverse(); // 如需时间升序

        if (!messages || messages.length === 0) {
            console.log('📭 监控流为空');
            return [];
        }

        return messages.map(message => {
            const fields = message.message;
            const record = {
                id: message.id,
                virtual_key: fields.virtual_key,
                path: fields.path,
                model: fields.model,
                method: fields.method,
                timestamp: fields.timestamp
            };

            // 解析 JSON 字段
            try {
                if (fields.usage) record.usage = JSON.parse(fields.usage);
                if (fields.performance) record.performance = JSON.parse(fields.performance);
                if (fields.provider_info) record.provider_info = JSON.parse(fields.provider_info);
                if (fields.tracing) record.tracing = JSON.parse(fields.tracing);
            } catch (parseError) {
                console.warn('JSON解析失败:', parseError);
            }

            return record;
        });
    } catch (error) {
        console.error('❌ 读取监控流失败:', error);
        return [];
    }
}

/**
 * 获取虚拟键使用统计
 */
async function getVirtualKeyStats(virtualKey) {
    try {
        if (!virtualKey) {
            console.warn('⚠️  virtualKey 参数为空');
            return null;
        }

        const client = await Redis.connect();
        const key = Redis.buildKey(Redis.schema.HASHES.VIRTUAL_KEY_USAGE.pattern, { virtual_key: virtualKey });
        const stats = await client.hGetAll(key)

        // 检查是否有数据
        if (Object.keys(stats).length === 0) {
            console.log(`📭 虚拟键 ${virtualKey} 无使用数据`);
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
    } catch (error) {
        console.error('❌ 获取虚拟键统计失败:', error);
        return null;
    }
}

/**
 * 获取Top N虚拟键（按token使用量）
 */
/**
 * 获取Top N虚拟键（按token使用量）
 */
async function getTopVirtualKeys(limit = 10) {
    try {
        // 用新优化 API: 从 sorted set 获取 top
        const ranked = await Redis.monitoring.getTopVirtualKeys(limit);
        // ranked 是 [ { value: virtualKey, score: total_tokens }, ... ]
        const statsPromises = ranked.map(async ({ value: virtualKey }) => {
            return await getVirtualKeyStats(virtualKey); // 仍需 fetch 详情
        });
        const stats = await Promise.all(statsPromises);
        return stats.filter(Boolean); // 过滤 null
    } catch (error) {
        console.error('获取Top虚拟键失败:', error);
        return [];
    }
}

/**
 * 获取缓存命中率统计
 */
async function getCacheStats() {
    try {

        const records = await getMonitoringStream(Redis.schema.STREAMS.API_MONITORING_STREAM, 100);

        if (records.length === 0) {
            return {
                total_requests: 0,
                cache_hits: 0,
                cache_misses: 0,
                hit_rate: '0%'
            };
        }

        const totalRequests = records.length;
        const cacheHits = records.filter(r => r.performance && r.performance.cache_status === 'HIT').length;

        const cacheStats = {
            total_requests: totalRequests,
            cache_hits: cacheHits,
            cache_misses: totalRequests - cacheHits,
            hit_rate: totalRequests > 0 ? (cacheHits / totalRequests * 100).toFixed(2) + '%' : '0%'
        };

        return cacheStats;
    } catch (error) {
        console.error('❌ 获取缓存统计失败:', error);
        return {
            total_requests: 0,
            cache_hits: 0,
            cache_misses: 0,
            hit_rate: '0%'
        };
    }
}

/**
 * 获取提供商统计
 */
async function getProviderStats(provider) {
    try {
        const client = await Redis.connect();
        const key = Redis.schema.buildKey(Redis.schema.HASHES.PROVIDER_STATS.pattern, { provider });
        const stats = await client.hGetAll(key);
        const date = new Date().toISOString().split('T')[0];

        return {
            provider: provider,
            total_requests: parseInt(stats.total_requests) || 0,
            total_tokens: parseInt(stats.total_tokens) || 0,
            cache_hits: parseInt(stats.cache_hits) || 0,
            total_retries: parseInt(stats.total_retries) || 0,
            daily_requests: parseInt(stats[`daily:${date}:requests`]) || 0,
            daily_tokens: parseInt(stats[`daily:${date}:tokens`]) || 0
        };
    } catch (error) {
        console.error('获取提供商统计失败:', error);
        return null;
    }
}

module.exports = {
    getMonitoringStream,
    getVirtualKeyStats,
    getProviderStats,
    getTopVirtualKeys,
    getCacheStats
};
