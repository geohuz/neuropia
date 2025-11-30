// src/services/monitoringService.js
const RedisService = require('@shared/clients/redis_op');

// ------------------------------
// 配置常量
// ------------------------------
const CONFIG = {
    MAX_RETRIES: 3,
    RETRY_DELAY: 100, // ms
    VALIDATION: {
        MAX_VIRTUAL_KEY_LENGTH: 255,
        MAX_PATH_LENGTH: 500,
        MAX_MODEL_LENGTH: 100
    }
};

// ------------------------------
// 数据验证函数
// ------------------------------

/**
 * 验证监控记录数据的完整性
 */
function validateMonitoringRecord(record) {
    const errors = [];

    if (!record || typeof record !== 'object') {
        return ['监控记录必须是一个对象'];
    }

    // 必需字段验证
    if (!record.virtual_key || typeof record.virtual_key !== 'string') {
        errors.push('virtual_key 必须为非空字符串');
    } else if (record.virtual_key.length > CONFIG.VALIDATION.MAX_VIRTUAL_KEY_LENGTH) {
        errors.push(`virtual_key 长度不能超过 ${CONFIG.VALIDATION.MAX_VIRTUAL_KEY_LENGTH} 字符`);
    }

    if (!record.path || typeof record.path !== 'string') {
        errors.push('path 必须为非空字符串');
    } else if (record.path.length > CONFIG.VALIDATION.MAX_PATH_LENGTH) {
        errors.push(`path 长度不能超过 ${CONFIG.VALIDATION.MAX_PATH_LENGTH} 字符`);
    }

    if (record.model && record.model.length > CONFIG.VALIDATION.MAX_MODEL_LENGTH) {
        errors.push(`model 长度不能超过 ${CONFIG.VALIDATION.MAX_MODEL_LENGTH} 字符`);
    }

    // 数值字段验证
    if (record.usage) {
        const usage = record.usage;
        const numberFields = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens'];

        numberFields.forEach(field => {
            if (usage[field] !== undefined && typeof usage[field] !== 'number') {
                errors.push(`usage.${field} 必须为数字`);
            } else if (usage[field] < 0) {
                errors.push(`usage.${field} 不能为负数`);
            }
        });
    }

    // 时间戳验证
    if (record.timestamp && !isValidISOString(record.timestamp)) {
        errors.push('timestamp 必须是有效的 ISO 字符串格式');
    }

    return errors;
}

/**
 * 验证 ISO 时间字符串
 */
function isValidISOString(dateString) {
    try {
        const date = new Date(dateString);
        return !isNaN(date.getTime()) && date.toISOString() === dateString;
    } catch {
        return false;
    }
}

// ------------------------------
// 重试工具函数
// ------------------------------

/**
 * 带重试的异步操作执行器
 */
async function executeWithRetry(operation, context, maxRetries = CONFIG.MAX_RETRIES) {
    let lastError;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;

            // 如果是最后一次尝试，直接抛出错误
            if (attempt === maxRetries - 1) break;

            // 计算退避延迟
            const delay = CONFIG.RETRY_DELAY * Math.pow(2, attempt);
            console.warn(`操作失败，${delay}ms 后重试 (${attempt + 1}/${maxRetries}):`, {
                context,
                error: error.message
            });

            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw lastError;
}

// ------------------------------
// 核心监控函数
// ------------------------------

/**
 * 记录完整的 API 请求监控数据
 * 现在支持两种调用方式：
 * 1. 直接传递 monitoringRecord 对象
 * 2. 传递原始数据 (userContext, portkeyResponse, requestBody, path)
 */
/**
 * 记录 API 请求监控数据
 * @param {Object} userContext - 用户上下文
 * @param {Object} portkeyResponse - Portkey 响应对象
 * @param {Object} responseBody - 响应体数据
 * @param {Object} requestBody - 请求体数据
 * @param {string} path - API 路径
 */
// monitoringService.js - 使用明确的参数
async function trackApiRequest(userContext, portkeyResponse, responseBody, requestBody, path) {
    // 参数验证
    if (!userContext?.virtual_key) {
        console.warn('trackApiRequest: userContext 或 virtual_key 为空');
        return;
    }

    if (!path) {
        console.warn('trackApiRequest: path 为空，使用默认值');
        path = '/unknown';
    }

    console.log('🔍 trackApiRequest 调用详情:', {
        virtual_key: userContext.virtual_key,
        path: path,
        hasPortkeyResponse: !!portkeyResponse,
        hasResponseBody: !!responseBody,
        hasRequestBody: !!requestBody
    });

    // 立即异步处理，不阻塞主请求
    process.nextTick(async () => {
        try {
            const monitoringRecord = buildMonitoringRecord(
                userContext,
                portkeyResponse,
                responseBody,
                requestBody,
                path
            );

            // 数据验证
            const validationErrors = validateMonitoringRecord(monitoringRecord);
            if (validationErrors.length > 0) {
                console.warn('❌ 监控数据验证失败:', {
                    errors: validationErrors,
                    virtual_key: monitoringRecord.virtual_key,
                    path: monitoringRecord.path
                });
                return;
            }

            // 转换为 Redis Stream 格式
            const streamRecord = {
                virtual_key: String(monitoringRecord.virtual_key || ''),
                path: String(monitoringRecord.path || ''),
                model: String(monitoringRecord.model || 'unknown'),
                method: String(monitoringRecord.method || 'POST'),

                usage: JSON.stringify(monitoringRecord.usage || {}),
                performance: JSON.stringify(monitoringRecord.performance || {}),
                provider_info: JSON.stringify(monitoringRecord.provider_info || {}),
                tracing: JSON.stringify(monitoringRecord.tracing || {}),

                timestamp: String(monitoringRecord.timestamp || new Date().toISOString())
            };

            console.log('📊 保存监控记录:', {
                virtual_key: monitoringRecord.virtual_key,
                path: monitoringRecord.path,
                provider: monitoringRecord.provider_info?.provider,
                tokens: monitoringRecord.usage?.total_tokens
            });

            // 记录到 Redis
            await RedisService.monitoring.trackApiRequest(streamRecord);

            // 更新统计信息
            await updateVirtualKeyUsage(monitoringRecord);
            await updateProviderStats(monitoringRecord);

            await trackCostAnalysis({
              user_id: userContext.virtual_key,
              tokens: {
                  total: monitoringRecord.usage.total_tokens || 0,
                  prompt: monitoringRecord.usage.prompt_tokens || 0,
                  completion: monitoringRecord.usage.completion_tokens || 0
              },
              timestamp: new Date().toISOString()
            });


            console.log('✅ 监控记录完成');

        } catch (error) {
            console.error('❌ 监控记录失败:', error);
        }
    });
}

/**
 * 转换为 Redis Stream 格式
 */
function convertToStreamFormat(monitoringRecord) {
    // 确保所有值为字符串，避免 Redis 序列化问题
    return {
        virtual_key: String(monitoringRecord.virtual_key || ''),
        path: String(monitoringRecord.path || ''),
        model: String(monitoringRecord.model || 'unknown'),
        method: String(monitoringRecord.method || 'POST'),

        // 将所有对象转换为 JSON 字符串
        usage: safeStringify(monitoringRecord.usage || {}),
        performance: safeStringify(monitoringRecord.performance || {}),
        provider_info: safeStringify(monitoringRecord.provider_info || {}),
        tracing: safeStringify(monitoringRecord.tracing || {}),

        timestamp: String(monitoringRecord.timestamp || new Date().toISOString())
    };
}

/**
 * 安全的 JSON 序列化
 */
function safeStringify(obj) {
    try {
        return JSON.stringify(obj);
    } catch (error) {
        console.warn('JSON 序列化失败，使用备用值:', error.message);
        return JSON.stringify({ error: '序列化失败', original_type: typeof obj });
    }
}

/**
 * 降级存储逻辑
 */
async function fallbackStorage(args, error) {
    try {
        // 这里可以实现写入本地文件、发送到备用服务等
        // 暂时只记录日志
        console.warn('监控数据降级处理 - 需要实现备用存储方案:', {
            timestamp: new Date().toISOString(),
            error: error.message,
            args_count: args.length
        });
    } catch (fallbackError) {
        console.error('降级存储也失败了:', fallbackError);
    }
}

/**
 * 从原始数据构建监控记录
 */
function buildMonitoringRecord(userContext, portkeyResponse, responseBody, requestBody, path) {
    // 收集所有可观测性头部
    const observabilityHeaders = collectObservabilityHeaders(portkeyResponse);

    // 从响应体获取用量信息（正确的方式）
    const usageFromBody = extractUsageFromResponse(responseBody);

    return {
        virtual_key: userContext.virtual_key,
        path: path,
        model: responseBody?.model || 'unknown',
        method: 'POST',

        // 用量信息 - 从响应体获取
        usage: usageFromBody,

        // 性能指标 - 从头部获取
        performance: {
          total_response_time: parseInt(observabilityHeaders['x-portkey-latency']) ||
                              parseInt(observabilityHeaders['req-cost-time']) || 0,
          gateway_processing_time: parseInt(observabilityHeaders['req-cost-time']) || 0,
          upstream_service_time: parseInt(observabilityHeaders['x-envoy-upstream-service-time']) || 0,
          cache_status: observabilityHeaders['x-portkey-cache-status'] || 'DISABLED'
        },

        // 提供商信息 - 从头部获取
        provider_info: {
            provider: observabilityHeaders['x-portkey-provider'] || 'unknown',
            config_path: observabilityHeaders['x-portkey-last-used-option-index'],
            retry_count: parseInt(observabilityHeaders['x-portkey-retry-attempt-count']) || 0
        },

        // 追踪信息 - 从头部获取
        tracing: {
            trace_id: observabilityHeaders['x-portkey-trace-id'],
            request_id: observabilityHeaders['x-request-id']
        },

        timestamp: new Date().toISOString()
    };
}

/**
 * 更新虚拟键使用统计
 */
async function updateVirtualKeyUsage(record) {
    try {
        const { virtual_key, usage } = record;
        if (!virtual_key) {
            console.warn('updateVirtualKeyUsage: virtual_key 为空');
            return;
        }

        console.log('🔍 更新虚拟键统计:', {
            virtual_key: virtual_key,
            usage: usage,
            total_tokens: usage?.total_tokens
        });

        await RedisService.monitoring.updateVirtualKeyStats(virtual_key, {
            request_count: 1,
            total_tokens: usage.total_tokens || 0,
            prompt_tokens: usage.prompt_tokens || 0,
            completion_tokens: usage.completion_tokens || 0,
            cached_tokens: usage.cached_tokens || 0,
            last_used: new Date().toISOString()
        });
    } catch (error) {
        console.error('更新虚拟键统计失败:', {
            virtual_key: record.virtual_key,
            error: error.message
        });
        throw error; // 重新抛出以便重试机制处理
    }
}

/**
 * 更新提供商级别统计
 */
async function updateProviderStats(record) {
    try {
        const { provider_info, usage, performance } = record;
        if (!provider_info?.provider) {
            console.warn('updateProviderStats: provider 为空');
            return;
        }

        console.log('🔍 更新提供商统计:', {
            provider: provider_info.provider,
            usage: usage,
            performance: performance
        });

        await RedisService.monitoring.updateProviderStats(provider_info.provider, {
            requests: 1,
            tokens: usage.total_tokens || 0,
            cache_hit: performance.cache_status === 'HIT',
            retry_count: provider_info.retry_count || 0
        });
    } catch (error) {
        console.error('更新提供商统计失败:', {
            provider: provider_info?.provider,
            error: error.message
        });
        throw error; // 重新抛出以便重试机制处理
    }
}

/**
 * 记录错误请求
 */
async function trackError(errorRecord) {
    return executeWithRetry(
        async () => {
            // 验证错误记录
            if (!errorRecord.virtual_key) {
                throw new Error('trackError: virtual_key 不能为空');
            }

            await RedisService.monitoring.trackError(errorRecord.virtual_key, errorRecord);

            console.log('❌ 错误记录已保存:', {
                status: errorRecord.error?.status_code,
                trace_id: errorRecord.error?.trace_id,
                virtual_key: errorRecord.virtual_key
            });
        },
        { operation: 'trackError', virtual_key: errorRecord.virtual_key }
    ).catch(error => {
        console.error('错误记录失败:', error);
    });
}

/**
 * 记录网络错误
 */
async function trackNetworkError(networkErrorRecord) {
    return executeWithRetry(
        async () => {
            await RedisService.stream.xadd(
                'network_error_stream',
                '*',
                networkErrorRecord
            );

            console.log('🌐 网络错误记录已保存:', {
                path: networkErrorRecord.network_error?.path,
                error: networkErrorRecord.network_error?.error_type
            });
        },
        { operation: 'trackNetworkError', path: networkErrorRecord.network_error?.path }
    ).catch(error => {
        console.error('网络错误记录失败:', error);
    });
}

/**
 * 成本分析记录
 */
async function trackCostAnalysis(costRecord) {
    return executeWithRetry(
        async () => {
            if (!costRecord.user_id) {
                throw new Error('trackCostAnalysis: user_id 不能为空');
            }

            await RedisService.stream.xadd(
                'cost_analysis_stream',
                '*',
                costRecord
            );

            // 按用户聚合成本
            const client = await RedisService.connect();
            const userCostKey = `user_costs:${costRecord.user_id}`;

            await client.multi()
                .hIncrBy(userCostKey, 'total_requests', 1)
                .hIncrBy(userCostKey, 'total_tokens', costRecord.tokens?.total || 0)
                .hIncrBy(userCostKey, 'prompt_tokens', costRecord.tokens?.prompt || 0)
                .hIncrBy(userCostKey, 'completion_tokens', costRecord.tokens?.completion || 0)
                .hSet(userCostKey, 'last_updated', new Date().toISOString())
                .expire(userCostKey, 2592000) // 30天
                .exec();

        },
        { operation: 'trackCostAnalysis', user_id: costRecord.user_id }
    ).catch(error => {
        console.error('成本记录失败:', error);
    });
}

// ------------------------------
// 工具函数 (保持不变)
// ------------------------------

/**
 * 从响应体中提取标准化的用量信息
 */
function extractUsageFromResponse(responseBody) {
    if (!responseBody || !responseBody.usage) {
        return {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            cached_tokens: 0
        };
    }

    const usage = responseBody.usage;
    return {
        // 基础用量
        prompt_tokens: usage.prompt_tokens || 0,
        completion_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || 0,

        // 缓存相关
        cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,

        // 推理相关（Google等）
        reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0,

        // 音频相关
        audio_tokens: (usage.prompt_tokens_details?.audio_tokens || 0) +
                     (usage.completion_tokens_details?.audio_tokens || 0)
    };
}

/**
 * 解析令牌头部信息
 */
function parseTokens(tokensHeader) {
    if (!tokensHeader) {
        return { prompt: 0, completion: 0, total: 0 };
    }

    try {
        return JSON.parse(tokensHeader);
    } catch {
        // 处理不同格式的令牌头部
        const parts = tokensHeader.split('/');
        return {
            prompt: parseInt(parts[0]) || 0,
            completion: parseInt(parts[1]) || 0,
            total: parseInt(parts[2]) || 0
        };
    }
}

/**
 * 收集所有可观测性相关的响应头
 */
function collectObservabilityHeaders(response) {
    const headers = {};

    // Portkey Gateway 特定头部
    const portkeyHeaders = [
        'x-portkey-cache-status',
        'x-portkey-last-used-option-index',
        'x-portkey-provider',
        'x-portkey-retry-attempt-count',
        'x-portkey-trace-id',
        'x-portkey-tokens',
        'x-portkey-cost',
        'x-portkey-latency',
        'x-portkey-model',
        'x-portkey-last-used-model'
    ];

    // 基础设施头部
    const infrastructureHeaders = [
        'req-arrive-time',
        'req-cost-time',
        'resp-start-time',
        'x-envoy-upstream-service-time',
        'x-request-id'
    ];

    // 收集所有头部
    [...portkeyHeaders, ...infrastructureHeaders].forEach(header => {
        const value = response.headers?.get?.(header);
        if (value) {
            headers[header] = value;
        }
    });

    console.log('🔍 Portkey 响应头中的性能数据:', {
        latency: headers['x-portkey-latency'],
        reqCostTime: headers['req-cost-time'],
        upstreamTime: headers['x-envoy-upstream-service-time']
    });

    return headers;
}

/**
 * 生成追踪ID
 */
function generateTraceId() {
    return `trace_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ------------------------------
// 导出所有函数
// ------------------------------

module.exports = {
    trackApiRequest,
    trackError,
    trackNetworkError,
    trackCostAnalysis,
    updateVirtualKeyUsage,
    updateProviderStats,
    extractUsageFromResponse,
    parseTokens,
    collectObservabilityHeaders,
    generateTraceId,
    // 导出工具函数用于测试
    validateMonitoringRecord,
    executeWithRetry
};
