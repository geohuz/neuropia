// src/clients/redis.js
const { createClient } = require("redis");
const REDIS_SCHEMA = require('./redisSchema');

let client = null;
let connecting = false;

async function getClient() {
    if (!client) {
        if (connecting) {
            // 如果正在连接，等待连接完成
            await new Promise(resolve => setTimeout(resolve, 100));
            return getClient();
        }

        connecting = true;
        try {
            console.log('🔄 创建 Redis 连接');
            client = createClient({
                url: process.env.REDIS_URL || "redis://localhost:6379",
                socket: {
                    reconnectStrategy: (retries) => Math.min(retries * 50, 1000)
                }
            });

            client.on("error", (err) => console.error("Redis Error:", err));
            await client.connect();
            console.log("✅ Redis connected");
        } finally {
            connecting = false;
        }
    }

    return client;
}

// 原有的基础 API
const kv = {
    get: async (key) => (await getClient()).get(key),
    setex: async (key, seconds, value) => (await getClient()).setEx(key, seconds, value),
    keys: async (pattern) => (await getClient()).keys(pattern),
    del: async (...keys) => (await getClient()).del(keys),
};

const stream = {
    xadd: async (streamKey, id = "*", fields = {}) => (await getClient()).xAdd(streamKey, id, fields),
    xread: async (streamKey, lastId = "$", blockMs = 5000) => (await getClient()).xRead({ key: streamKey, id: lastId }, { BLOCK: blockMs }),
    xlen: async (streamKey) => (await getClient()).xLen(streamKey),
};

// 新增的监控专用 API
const monitoring = {
    /**
     * 记录API监控数据到Stream
     */
    trackApiRequest: async (monitoringData) => {
        const client = await getClient();
        return client.xAdd(
            REDIS_SCHEMA.STREAMS.API_MONITORING_STREAM,
            '*',
            monitoringData
        );
    },

    /**
     * 更新虚拟键使用统计
     */
    updateVirtualKeyStats: async (virtualKey, stats) => {
        const client = await getClient();
        const key = `usage:${virtualKey}`;

        const pipeline = client.multi()
            .hIncrBy(key, 'request_count', stats.request_count || 1)
            .hIncrBy(key, 'total_tokens', stats.total_tokens || 0)
            .hIncrBy(key, 'prompt_tokens', stats.prompt_tokens || 0)
            .hIncrBy(key, 'completion_tokens', stats.completion_tokens || 0)
            .hIncrBy(key, 'cached_tokens', stats.cached_tokens || 0);

        // 更新最后使用时间
        if (stats.last_used) {
            pipeline.hSet(key, 'last_used', stats.last_used);
        }

        // 更新排名
        if (stats.total_tokens) {
            pipeline.zIncrBy(
                REDIS_SCHEMA.SORTED_SETS.VIRTUAL_KEY_RANKING,
                stats.total_tokens,
                virtualKey
            );
        }

        pipeline.expire(key, REDIS_SCHEMA.HASHES.VIRTUAL_KEY_USAGE.ttl);
        return pipeline.exec();
    },

    /**
     * 更新提供商统计
     */
    updateProviderStats: async (provider, stats) => {
        const client = await getClient();
        const key = `provider_stats:${provider}`;
        const date = new Date().toISOString().split('T')[0];

        const pipeline = client.multi()
            .hIncrBy(key, 'total_requests', stats.requests || 1)
            .hIncrBy(key, 'total_tokens', stats.tokens || 0)
            .hIncrBy(key, `daily:${date}:requests`, stats.requests || 1)
            .hIncrBy(key, `daily:${date}:tokens`, stats.tokens || 0);

        // 缓存命中
        if (stats.cache_hit) {
            pipeline.hIncrBy(key, 'cache_hits', 1);
        }

        // 重试次数
        if (stats.retry_count) {
            pipeline.hIncrBy(key, 'total_retries', stats.retry_count);
        }

        // 更新提供商排名
        if (stats.tokens) {
            pipeline.zIncrBy(
                REDIS_SCHEMA.SORTED_SETS.PROVIDER_RANKING,
                stats.tokens,
                provider
            );
        }

        pipeline.expire(key, REDIS_SCHEMA.HASHES.PROVIDER_STATS.ttl);
        return pipeline.exec();
    },

    /**
     * 获取Top N虚拟键
     */
    getTopVirtualKeys: async (limit = 10) => {
        const client = await getClient();

        // 先检查 Sorted Set 是否存在
        const keyExists = await client.exists(REDIS_SCHEMA.SORTED_SETS.VIRTUAL_KEY_RANKING);
        if (!keyExists) {
            console.log('⚠️  Sorted Set 不存在，返回空数组');
            return [];
        }

        return client.zRevRangeWithScores(
            REDIS_SCHEMA.SORTED_SETS.VIRTUAL_KEY_RANKING,
            0,
            limit - 1
        );
    },

    /**
     * 获取Top N提供商
     */
    getTopProviders: async (limit = 10) => {
        const client = await getClient();
        return client.zRevRangeWithScores(
            REDIS_SCHEMA.SORTED_SETS.PROVIDER_RANKING,
            0,
            limit - 1
        );
    },

    /**
     * 记录错误
     */
    trackError: async (virtualKey, errorData) => {
        const client = await getClient();

        const pipeline = client.multi()
            // 记录到错误Stream
            .xAdd(
                REDIS_SCHEMA.STREAMS.ERROR_STREAM,
                '*',
                errorData
            )
            // 更新错误统计
            .hIncrBy(
                `errors:${virtualKey}`,
                errorData.status_code || 'unknown',
                1
            );

        return pipeline.exec();
    }
};

// 原有的业务逻辑
const biz = {
    cacheProviderRates: async (rates) => (await getClient()).set("provider_rates", JSON.stringify(rates), { EX: 3600 }),
    getProviderRates: async () => {
        const val = await (await getClient()).get("provider_rates");
        return val ? JSON.parse(val) : [];
    },
    incrementVirtualKeyUsage: async (vk, tokens = 0) => {
        const c = await getClient();
        const key = `usage:${vk}`;
        await c.multi()
            .hIncrBy(key, "request_count", 1)
            .hIncrBy(key, "token_count", tokens)
            .hSet(key, "last_used", new Date().toISOString())
            .expire(key, 86400)
            .exec();
    },
};

module.exports = {
    connect: getClient,
    kv,
    stream,
    biz,
    monitoring, // 新增的监控API
    schema: REDIS_SCHEMA // 导出结构定义
};
