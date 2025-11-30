const REDIS_SCHEMA = {
    // --------------------------
    // Streams (时间序列数据)
    // --------------------------
    STREAMS: {
        // 原始 Stream
        USAGE_STREAM: 'usage_stream',

        // 新增 Streams
        API_MONITORING_STREAM: 'api_monitoring_stream',
        ERROR_STREAM: 'error_stream',
        NETWORK_ERROR_STREAM: 'network_error_stream',
        COST_ANALYSIS_STREAM: 'cost_analysis_stream'
    },

    // --------------------------
    // Hashes (统计和聚合数据)
    // --------------------------
    HASHES: {
        // 虚拟键使用统计 (增强版)
        VIRTUAL_KEY_USAGE: {
            pattern: 'usage:{virtual_key}',
            fields: {
                request_count: '累计请求数',
                total_tokens: '总token数',
                prompt_tokens: '输入token数',
                completion_tokens: '输出token数',
                cached_tokens: '缓存token数',
                last_used: '最后使用时间',
                // 新增字段
                total_cost: '总成本',
                avg_response_time: '平均响应时间'
            },
            ttl: 86400 // 24小时
        },

        // 提供商统计
        PROVIDER_STATS: {
            pattern: 'provider_stats:{provider}',
            fields: {
                total_requests: '总请求数',
                total_tokens: '总token数',
                cache_hits: '缓存命中数',
                total_retries: '总重试次数',
                error_count: '错误计数',
                avg_latency: '平均延迟'
            },
            ttl: 2592000 // 30天
        },

        // 每日统计 (新增)
        DAILY_STATS: {
            pattern: 'stats:daily:{date}',
            fields: {
                total_requests: '日请求总数',
                total_tokens: '日token总数',
                unique_users: '独立用户数',
                unique_virtual_keys: '独立虚拟键数'
            },
            ttl: 604800 // 7天
        },

        // 用户成本聚合 (新增)
        USER_COSTS: {
            pattern: 'user_costs:{user_id}',
            fields: {
                total_requests: '用户总请求数',
                total_tokens: '用户总token数',
                prompt_tokens: '用户输入token数',
                completion_tokens: '用户输出token数',
                estimated_cost: '预估成本',
                last_updated: '最后更新时间'
            },
            ttl: 2592000 // 30天
        },

        // 错误统计 (新增)
        ERROR_STATS: {
            pattern: 'errors:{virtual_key}',
            fields: {
                // 动态字段: status_code -> count
            },
            ttl: 604800 // 7天
        }
    },

    // --------------------------
    // Sorted Sets (排名和Top N)
    // --------------------------
    SORTED_SETS: {
        // 虚拟键使用排名 (新增)
        VIRTUAL_KEY_RANKING: 'ranking:virtual_keys',
        // 提供商使用排名 (新增)
        PROVIDER_RANKING: 'ranking:providers',
        // 模型使用排名 (新增)
        MODEL_RANKING: 'ranking:models'
    },

    // --------------------------
    // Strings (配置和缓存)
    // --------------------------
    STRINGS: {
        // 原始配置
        PROVIDER_RATES: 'provider_rates',

        // 新增配置
        RATE_LIMITS: 'config:rate_limits',
        COST_CONFIG: 'config:cost_rates'
    }
};

module.exports = REDIS_SCHEMA;
