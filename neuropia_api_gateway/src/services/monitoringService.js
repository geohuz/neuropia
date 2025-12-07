// src/services/monitoringService.js
const RedisService = require("@shared/clients/redis_op");
const REDIS_SCHEMA = require("@shared/clients/redisSchema");
const logger = require("@shared/utils/logger"); // 假设你创建了logger

// ------------------------------
// 配置常量
// ------------------------------
const CONFIG = {
  MAX_RETRIES: 3,
  RETRY_DELAY: 100, // ms
  VALIDATION: {
    MAX_VIRTUAL_KEY_LENGTH: 255,
    MAX_PATH_LENGTH: 500,
    MAX_MODEL_LENGTH: 100,
  },
};

// ------------------------------
// 数据验证函数
// ------------------------------
function validateMonitoringRecord(record) {
  const errors = [];

  if (!record || typeof record !== "object") {
    return ["监控记录必须是一个对象"];
  }

  if (!record.virtual_key || typeof record.virtual_key !== "string") {
    errors.push("virtual_key 必须为非空字符串");
  } else if (
    record.virtual_key.length > CONFIG.VALIDATION.MAX_VIRTUAL_KEY_LENGTH
  ) {
    errors.push(
      `virtual_key 长度不能超过 ${CONFIG.VALIDATION.MAX_VIRTUAL_KEY_LENGTH} 字符`,
    );
  }

  if (!record.path || typeof record.path !== "string") {
    errors.push("path 必须为非空字符串");
  } else if (record.path.length > CONFIG.VALIDATION.MAX_PATH_LENGTH) {
    errors.push(`path 长度不能超过 ${CONFIG.VALIDATION.MAX_PATH_LENGTH} 字符`);
  }

  if (
    record.model &&
    record.model.length > CONFIG.VALIDATION.MAX_MODEL_LENGTH
  ) {
    errors.push(
      `model 长度不能超过 ${CONFIG.VALIDATION.MAX_MODEL_LENGTH} 字符`,
    );
  }

  if (record.usage) {
    const usage = record.usage;
    const numberFields = [
      "prompt_tokens",
      "completion_tokens",
      "total_tokens",
      "cached_tokens",
    ];
    numberFields.forEach((field) => {
      if (usage[field] !== undefined && typeof usage[field] !== "number") {
        errors.push(`usage.${field} 必须为数字`);
      } else if (usage[field] < 0) {
        errors.push(`usage.${field} 不能为负数`);
      }
    });
  }

  if (record.timestamp && !isValidISOString(record.timestamp)) {
    errors.push("timestamp 必须是有效的 ISO 字符串格式");
  }

  return errors;
}

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
async function executeWithRetry(
  operation,
  context,
  maxRetries = CONFIG.MAX_RETRIES,
) {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries - 1) break;
      const delay = CONFIG.RETRY_DELAY * Math.pow(2, attempt);
      logger.warn(
        `操作失败，${delay}ms 后重试 (${attempt + 1}/${maxRetries}):`,
        {
          context,
          error: error.message,
          attempt: attempt + 1,
          maxRetries,
        },
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// ------------------------------
// 核心监控函数
// ------------------------------
async function trackApiRequest(
  userContext,
  portkeyResponse,
  responseBody,
  requestBody,
  path,
) {
  if (!userContext?.virtual_key) {
    logger.warn("trackApiRequest: userContext 或 virtual_key 为空");
    return;
  }

  if (!path) {
    logger.warn("trackApiRequest: path 为空，使用默认值");
    path = "/unknown";
  }

  process.nextTick(async () => {
    try {
      const monitoringRecord = buildMonitoringRecord(
        userContext,
        portkeyResponse,
        responseBody,
        requestBody,
        path,
      );

      const validationErrors = validateMonitoringRecord(monitoringRecord);
      if (validationErrors.length > 0) {
        logger.warn("❌ 监控数据验证失败:", {
          errors: validationErrors,
          virtual_key: monitoringRecord.virtual_key,
          path: monitoringRecord.path,
        });
        return;
      }

      const streamRecord = convertToStreamFormat(monitoringRecord);

      logger.info("📊 保存监控记录:", {
        virtual_key: monitoringRecord.virtual_key,
        path: monitoringRecord.path,
        provider: monitoringRecord.provider_info?.provider,
        tokens: monitoringRecord.usage?.total_tokens,
      });

      await RedisService.monitoring.trackApiRequest(streamRecord);

      await updateVirtualKeyUsage(monitoringRecord);
      await updateProviderStats(monitoringRecord);
      await updateSortedSets(monitoringRecord);

      await trackCostAnalysis({
        user_id: userContext.virtual_key,
        tokens: {
          total: monitoringRecord.usage.total_tokens || 0,
          prompt: monitoringRecord.usage.prompt_tokens || 0,
          completion: monitoringRecord.usage.completion_tokens || 0,
        },
        timestamp: new Date().toISOString(),
      });

      logger.info("✅ 监控记录完成");
    } catch (error) {
      logger.error("❌ 监控记录失败:", {
        virtual_key: userContext?.virtual_key,
        path: path,
        error: error.message,
        stack: error.stack,
        code: error.code,
      });
    }
  });
}

function convertToStreamFormat(record) {
  return {
    virtual_key: String(record.virtual_key || ""),
    path: String(record.path || ""),
    model: String(record.model || "unknown"),
    method: String(record.method || "POST"),
    usage: safeStringify(record.usage || {}),
    performance: safeStringify(record.performance || {}),
    provider_info: safeStringify(record.provider_info || {}),
    tracing: safeStringify(record.tracing || {}),
    timestamp: String(record.timestamp || new Date().toISOString()),
  };
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch (error) {
    logger.warn("JSON 序列化失败，使用备用值:", error.message);
    return JSON.stringify({ error: "序列化失败", original_type: typeof obj });
  }
}

async function fallbackStorage(args, error) {
  logger.warn("监控数据降级处理 - 需要实现备用存储方案:", {
    timestamp: new Date().toISOString(),
    error: error.message,
    args_count: args.length,
  });
}

// ------------------------------
// 构建监控记录
// ------------------------------
function buildMonitoringRecord(
  userContext,
  portkeyResponse,
  responseBody,
  requestBody,
  path,
) {
  const observabilityHeaders = collectObservabilityHeaders(portkeyResponse);
  const usageFromBody = extractUsageFromResponse(responseBody);

  return {
    virtual_key: userContext.virtual_key,
    path,
    model: responseBody?.model || "unknown",
    method: "POST",
    usage: usageFromBody,
    performance: {
      total_response_time:
        parseInt(observabilityHeaders["x-portkey-latency"]) ||
        parseInt(observabilityHeaders["req-cost-time"]) ||
        0,
      gateway_processing_time:
        parseInt(observabilityHeaders["req-cost-time"]) || 0,
      upstream_service_time:
        parseInt(observabilityHeaders["x-envoy-upstream-service-time"]) || 0,
      cache_status:
        observabilityHeaders["x-portkey-cache-status"] || "DISABLED",
    },
    provider_info: {
      provider: observabilityHeaders["x-portkey-provider"] || "unknown",
      config_path: observabilityHeaders["x-portkey-last-used-option-index"],
      retry_count:
        parseInt(observabilityHeaders["x-portkey-retry-attempt-count"]) || 0,
    },
    tracing: {
      trace_id: observabilityHeaders["x-portkey-trace-id"],
      request_id: observabilityHeaders["x-request-id"],
    },
    timestamp: new Date().toISOString(),
  };
}

// ------------------------------
// 更新虚拟键使用统计
// ------------------------------
async function updateVirtualKeyUsage(record) {
  try {
    const { virtual_key, usage } = record;
    if (!virtual_key) return;
    const client = await RedisService.connect();
    const key = REDIS_SCHEMA.buildKey(
      REDIS_SCHEMA.HASHES.VIRTUAL_KEY_USAGE.pattern,
      { virtual_key },
    );
    await client
      .multi()
      .hIncrBy(key, "request_count", 1)
      .hIncrBy(key, "total_tokens", usage.total_tokens || 0)
      .hIncrBy(key, "prompt_tokens", usage.prompt_tokens || 0)
      .hIncrBy(key, "completion_tokens", usage.completion_tokens || 0)
      .hIncrBy(key, "cached_tokens", usage.cached_tokens || 0)
      .hSet(key, "last_used", new Date().toISOString())
      .expire(key, REDIS_SCHEMA.HASHES.VIRTUAL_KEY_USAGE.ttl)
      .exec();
  } catch (error) {
    console.error("更新虚拟键统计失败:", {
      virtual_key: record.virtual_key,
      error: error.message,
      stack: error.stack,
      code: error.code,
    });
    throw error;
  }
}

// ------------------------------
// 更新提供商统计
// ------------------------------
async function updateProviderStats(record) {
  try {
    const { provider_info, usage, performance } = record;
    if (!provider_info?.provider) {
      logger.warn("updateProviderStats: provider 为空");
      return;
    }

    const client = await RedisService.connect();
    const key = REDIS_SCHEMA.buildKey(
      REDIS_SCHEMA.HASHES.PROVIDER_STATS.pattern,
      { provider: provider_info.provider },
    );

    await client
      .multi()
      .hIncrBy(key, "requests", 1)
      .hIncrBy(key, "tokens", usage.total_tokens || 0)
      .hSet(key, "cache_hit", performance.cache_status === "HIT" ? "1" : "0") // 修复 boolean
      .hSet(key, "retry_count", provider_info.retry_count || 0)
      .hSet(key, "last_updated", new Date().toISOString())
      .expire(key, REDIS_SCHEMA.HASHES.PROVIDER_STATS.ttl)
      .exec();
  } catch (error) {
    logger.error("更新提供商统计失败:", {
      provider: provider_info?.provider,
      virtual_key: record.virtual_key,
      error: error.message,
      stack: error.stack,
    });
    throw error; // 重新抛出以便重试机制处理
  }
}

// ------------------------------
// 错误记录
// ------------------------------
async function trackError(errorRecord) {
  return executeWithRetry(
    async () => {
      if (!errorRecord.virtual_key)
        throw new Error("trackError: virtual_key 不能为空");
      const key = REDIS_SCHEMA.STREAMS.ERROR_STREAM;
      await RedisService.stream.xadd(key, "*", errorRecord);
    },
    { operation: "trackError", virtual_key: errorRecord.virtual_key },
  ).catch((error) => {
    logger.error("trackError 失败:", {
      virtual_key: errorRecord.virtual_key,
      error: error.message,
      stack: error.stack,
    });
  });
}

async function trackNetworkError(networkErrorRecord) {
  return executeWithRetry(
    async () => {
      const key = REDIS_SCHEMA.STREAMS.NETWORK_ERROR_STREAM;
      await RedisService.stream.xadd(key, "*", networkErrorRecord);
    },
    {
      operation: "trackNetworkError",
      path: networkErrorRecord.network_error?.path,
    },
  ).catch((error) => {
    logger.error("trackNetworkError 失败:", {
      path: networkErrorRecord.network_error?.path,
      error: error.message,
      stack: error.stack,
    });
  });
}

// ------------------------------
// 成本分析记录
// ------------------------------
async function trackCostAnalysis(costRecord) {
  return executeWithRetry(
    async () => {
      if (!costRecord.user_id)
        throw new Error("trackCostAnalysis: user_id 不能为空");
      const streamKey = REDIS_SCHEMA.STREAMS.COST_ANALYSIS_STREAM;
      await RedisService.stream.xadd(streamKey, "*", costRecord);

      const client = await RedisService.connect();
      const userCostKey = REDIS_SCHEMA.buildKey(
        REDIS_SCHEMA.HASHES.USER_COSTS.pattern,
        { user_id: costRecord.user_id },
      );
      await client
        .multi()
        .hIncrBy(userCostKey, "total_requests", 1)
        .hIncrBy(userCostKey, "total_tokens", costRecord.tokens?.total || 0)
        .hIncrBy(userCostKey, "prompt_tokens", costRecord.tokens?.prompt || 0)
        .hIncrBy(
          userCostKey,
          "completion_tokens",
          costRecord.tokens?.completion || 0,
        )
        .hSet(userCostKey, "last_updated", new Date().toISOString())
        .expire(userCostKey, REDIS_SCHEMA.HASHES.USER_COSTS.ttl)
        .exec();
    },
    { operation: "trackCostAnalysis", user_id: costRecord.user_id },
  ).catch((error) => {
    logger.error("trackCostAnalysis 失败:", {
      user_id: costRecord.user_id,
      error: error.message,
      stack: error.stack,
    });
  });
}

// ------------------------------
// 工具函数
// ------------------------------
function extractUsageFromResponse(responseBody) {
  if (!responseBody || !responseBody.usage)
    return {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cached_tokens: 0,
    };
  const usage = responseBody.usage;
  return {
    prompt_tokens: usage.prompt_tokens || 0,
    completion_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0,
    cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0,
    cache_read_input_tokens: usage.cache_read_input_tokens || 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
    reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0,
    audio_tokens:
      (usage.prompt_tokens_details?.audio_tokens || 0) +
      (usage.completion_tokens_details?.audio_tokens || 0),
  };
}

function parseTokens(tokensHeader) {
  if (!tokensHeader) return { prompt: 0, completion: 0, total: 0 };
  try {
    return JSON.parse(tokensHeader);
  } catch {
    const parts = tokensHeader.split("/");
    return {
      prompt: parseInt(parts[0]) || 0,
      completion: parseInt(parts[1]) || 0,
      total: parseInt(parts[2]) || 0,
    };
  }
}

function collectObservabilityHeaders(response) {
  const headers = {};
  const portkeyHeaders = [
    "x-portkey-cache-status",
    "x-portkey-last-used-option-index",
    "x-portkey-provider",
    "x-portkey-retry-attempt-count",
    "x-portkey-trace-id",
    "x-portkey-tokens",
    "x-portkey-cost",
    "x-portkey-latency",
    "x-portkey-model",
    "x-portkey-last-used-model",
  ];
  const infrastructureHeaders = [
    "req-arrive-time",
    "req-cost-time",
    "resp-start-time",
    "x-envoy-upstream-service-time",
    "x-request-id",
  ];
  [...portkeyHeaders, ...infrastructureHeaders].forEach((header) => {
    const value = response.headers?.get?.(header);
    if (value) headers[header] = value;
  });
  return headers;
}

function generateTraceId() {
  return `trace_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ------------------------------
// 更新 ZSET 统计
// ------------------------------
async function updateSortedSets(record) {
  try {
    const client = await RedisService.connect();
    const { virtual_key, usage, provider_info } = record;

    if (virtual_key) {
      // 用户使用量 ZSET
      const userZSetKey = REDIS_SCHEMA.SORTED_SETS.VIRTUAL_KEY_TOTAL_TOKENS;
      await client.zIncrBy(userZSetKey, usage.total_tokens || 0, virtual_key);
    }

    if (provider_info?.provider) {
      // 服务商性能 ZSET
      const providerZSetKey = REDIS_SCHEMA.SORTED_SETS.PROVIDER_TOTAL_TOKENS;
      await client.zIncrBy(
        providerZSetKey,
        usage.total_tokens || 0,
        provider_info.provider,
      );
    }
  } catch (error) {
    logger.error("更新 ZSET 失败:", {
      virtual_key: record.virtual_key,
      provider: record.provider_info?.provider,
      error: error.message,
      stack: error.stack,
    });
  }
}

// ------------------------------
// 导出
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
  validateMonitoringRecord,
  executeWithRetry,
};
