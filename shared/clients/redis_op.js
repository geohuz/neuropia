// redis_op.js
const { createClient } = require("redis");
const REDIS_SCHEMA = require("./redisSchema");

let client = null;
let connecting = false;
let connectionErrors = 0;
const MAX_CONNECTION_ERRORS = 5;

// ------------------------------
// 连接管理增强
// ------------------------------

async function getClient() {
  if (!client) {
    if (connecting) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return getClient();
    }
    connecting = true;
    try {
      console.log("🔄 创建 Redis 连接");
      client = createClient({
        url: process.env.REDIS_URL || "redis://localhost:6379",
        socket: {
          reconnectStrategy: (retries) => {
            const delay = Math.min(retries * 50, 2000);
            console.log(`Redis 重连尝试 ${retries}, 延迟 ${delay}ms`);
            return delay;
          },
          connectTimeout: 10000,
          lazyConnect: true,
        },
        pingInterval: 30000, // 30秒心跳
      });

      // 增强事件监听
      client.on("error", (err) => {
        console.error("Redis 客户端错误:", err);
        connectionErrors++;

        if (connectionErrors >= MAX_CONNECTION_ERRORS) {
          console.error("Redis 连接错误次数过多，考虑重启服务");
        }
      });

      client.on("connect", () => {
        console.log("✅ Redis 连接中...");
        connectionErrors = 0; // 重置错误计数
      });

      client.on("ready", () => {
        console.log("✅ Redis 已就绪");
        connectionErrors = 0;
      });

      client.on("disconnect", () => {
        console.warn("⚠️ Redis 连接断开");
      });

      client.on("reconnecting", () => {
        console.log("🔄 Redis 重新连接中...");
      });

      await client.connect();
      console.log("✅ Redis 连接成功");
    } catch (error) {
      console.error("❌ Redis 连接失败:", error);
      client = null;
      throw error;
    } finally {
      connecting = false;
    }
  }
  return client;
}

/**
 * 健康检查
 */
async function healthCheck() {
  try {
    const currentClient = await getClient();
    await currentClient.ping();
    return {
      status: "healthy",
      timestamp: new Date().toISOString(),
      connectionErrors,
    };
  } catch (error) {
    return {
      status: "unhealthy",
      error: error.message,
      timestamp: new Date().toISOString(),
      connectionErrors,
    };
  }
}

/**
 * 强制重新连接
 */
async function forceReconnect() {
  if (client) {
    try {
      await client.quit();
    } catch (error) {
      console.warn("关闭旧连接时出错:", error);
    }
    client = null;
  }
  connectionErrors = 0;
  return getClient();
}

// ------------------------------
// 基础操作增强
// ------------------------------

const kv = {
  get: async (key) => {
    const client = await getClient();
    return client.get(key);
  },
  setex: async (key, seconds, value) => {
    const client = await getClient();
    return client.setEx(key, seconds, value);
  },
  keys: async (pattern) => {
    const client = await getClient();
    return client.keys(pattern);
  },
  del: async (...keys) => {
    const client = await getClient();
    return client.del(keys);
  },
  exists: async (key) => {
    const client = await getClient();
    return client.exists(key);
  },
};

const stream = {
  xadd: async (streamKey, id = "*", fields = {}) => {
    const client = await getClient();

    // 验证字段值都是字符串
    const validatedFields = {};
    Object.keys(fields).forEach((key) => {
      const value = fields[key];
      validatedFields[key] =
        value !== null && value !== undefined ? String(value) : "";
    });

    return client.xAdd(streamKey, id, validatedFields);
  },
  xread: async (streamKey, lastId = "$", blockMs = 5000) => {
    const client = await getClient();
    return client.xRead({ key: streamKey, id: lastId }, { BLOCK: blockMs });
  },
  xlen: async (streamKey) => {
    const client = await getClient();
    return client.xLen(streamKey);
  },
  xrange: async (streamKey, start = "-", end = "+", count = 100) => {
    const client = await getClient();
    return client.xRange(streamKey, start, end, { COUNT: count });
  },
};

// ------------------------------
// 监控操作增强
// ------------------------------

const monitoring = {
  /**
   * 记录 API 请求到监控流
   */
  trackApiRequest: async (monitoringData) => {
    const client = await getClient();

    // 数据验证
    if (!monitoringData.virtual_key) {
      throw new Error("monitoringData.virtual_key 不能为空");
    }

    return client.xAdd(
      REDIS_SCHEMA.STREAMS.API_MONITORING_STREAM,
      "*",
      monitoringData,
    );
  },

  /**
   * 更新虚拟键统计信息
   */
  updateVirtualKeyStats: async (virtualKey, stats) => {
    const client = await getClient();
    const key = `usage:${virtualKey}`;

    console.log("🔍 Redis - 更新虚拟键统计:", {
      virtualKey,
      key,
      stats,
    });

    // 参数验证
    if (!virtualKey) {
      throw new Error("virtualKey 不能为空");
    }

    const pipeline = client
      .multi()
      .hIncrBy(key, "request_count", stats.request_count || 1)
      .hIncrBy(key, "total_tokens", stats.total_tokens || 0)
      .hIncrBy(key, "prompt_tokens", stats.prompt_tokens || 0)
      .hIncrBy(key, "completion_tokens", stats.completion_tokens || 0)
      .hIncrBy(key, "cached_tokens", stats.cached_tokens || 0);

    if (stats.last_used) {
      pipeline.hSet(key, "last_used", stats.last_used);
    }

    if (stats.total_tokens) {
      pipeline.zIncrBy(
        REDIS_SCHEMA.SORTED_SETS.VIRTUAL_KEY_RANKING,
        stats.total_tokens,
        virtualKey,
      );
    }

    pipeline.expire(key, REDIS_SCHEMA.HASHES.VIRTUAL_KEY_USAGE.ttl);

    const results = await pipeline.exec();

    // 检查管道执行结果
    results.forEach((result, index) => {
      if (result instanceof Error) {
        console.error(`Redis 管道操作 ${index} 失败:`, result);
      }
    });

    return results;
  },

  /**
   * 更新提供商统计信息
   */
  updateProviderStats: async (provider, stats) => {
    const client = await getClient();
    const key = `provider_stats:${provider}`;
    const date = new Date().toISOString().split("T")[0];

    // 参数验证
    if (!provider) {
      throw new Error("provider 不能为空");
    }

    console.log("🔍 Redis - 更新提供商统计:", {
      provider,
      key,
      stats,
    });

    console.log("🔍 更新提供商统计 - 日期字段:", {
      date: date,
      dailyRequestsKey: `daily:${date}:requests`,
      dailyTokensKey: `daily:${date}:tokens`,
    });

    const pipeline = client
      .multi()
      .hIncrBy(key, "total_requests", stats.requests || 1)
      .hIncrBy(key, "total_tokens", stats.tokens || 0)
      .hIncrBy(key, `daily:${date}:requests`, stats.requests || 1)
      .hIncrBy(key, `daily:${date}:tokens`, stats.tokens || 0);

    if (stats.cache_hit) {
      pipeline.hIncrBy(key, "cache_hits", 1);
    }

    if (stats.retry_count) {
      pipeline.hIncrBy(key, "total_retries", stats.retry_count);
    }

    if (stats.tokens) {
      pipeline.zIncrBy(
        REDIS_SCHEMA.SORTED_SETS.PROVIDER_RANKING,
        stats.tokens,
        provider,
      );
    }

    pipeline.expire(key, REDIS_SCHEMA.HASHES.PROVIDER_STATS.ttl);

    const results = await pipeline.exec();

    // 检查管道执行结果
    results.forEach((result, index) => {
      if (result instanceof Error) {
        console.error(`Redis 管道操作 ${index} 失败:`, result);
      }
    });

    return results;
  },

  /**
   * 获取顶级虚拟键排名
   */
  getTopVirtualKeys: async (limit = 10) => {
    const client = await getClient();
    const keyExists = await client.exists(
      REDIS_SCHEMA.SORTED_SETS.VIRTUAL_KEY_RANKING,
    );

    if (!keyExists) {
      console.log("⚠️  虚拟键排名 Sorted Set 不存在，返回空数组");
      return [];
    }

    try {
      // 使用 zRangeWithScores + REV 选项
      const result = await client.zRangeWithScores(
        REDIS_SCHEMA.SORTED_SETS.VIRTUAL_KEY_RANKING,
        0,
        limit - 1,
        { REV: true }, // 反向排序
      );

      console.log("🔍 getTopVirtualKeys 返回:", result);
      return result;
    } catch (error) {
      console.error("获取虚拟键排名失败:", error);
      return [];
    }
  },

  /**
   * 获取顶级提供商排名
   */
  getTopProviders: async (limit = 10) => {
    const client = await getClient();
    const keyExists = await client.exists(
      REDIS_SCHEMA.SORTED_SETS.PROVIDER_RANKING,
    );

    if (!keyExists) {
      console.log("⚠️  提供商排名 Sorted Set 不存在，返回空数组");
      return [];
    }

    try {
      const result = await client.zRangeWithScores(
        REDIS_SCHEMA.SORTED_SETS.PROVIDER_RANKING,
        0,
        limit - 1,
        { REV: true }, // 反向排序
      );
      return result;
    } catch (error) {
      console.error("获取提供商排名失败:", error);
      return [];
    }
  },

  /**
   * 记录错误信息
   */
  trackError: async (virtualKey, errorData) => {
    const client = await getClient();

    // 参数验证
    if (!virtualKey) {
      throw new Error("virtualKey 不能为空");
    }

    if (!errorData || typeof errorData !== "object") {
      throw new Error("errorData 必须是一个对象");
    }

    const pipeline = client
      .multi()
      .xAdd(REDIS_SCHEMA.STREAMS.ERROR_STREAM, "*", errorData)
      .hIncrBy(`errors:${virtualKey}`, errorData.status_code || "unknown", 1);

    const results = await pipeline.exec();

    // 检查管道执行结果
    results.forEach((result, index) => {
      if (result instanceof Error) {
        console.error(`错误记录管道操作 ${index} 失败:`, result);
      }
    });

    return results;
  },

  /**
   * 获取虚拟键使用统计
   */
  getVirtualKeyStats: async (virtualKey) => {
    const client = await getClient();
    const key = `usage:${virtualKey}`;

    if (!virtualKey) {
      throw new Error("virtualKey 不能为空");
    }

    try {
      const stats = await client.hGetAll(key);

      // 转换数值字段
      const numberFields = [
        "request_count",
        "total_tokens",
        "prompt_tokens",
        "completion_tokens",
        "cached_tokens",
      ];
      numberFields.forEach((field) => {
        if (stats[field]) {
          stats[field] = parseInt(stats[field], 10);
        }
      });

      return stats;
    } catch (error) {
      console.error(`获取虚拟键 ${virtualKey} 统计失败:`, error);
      return {};
    }
  },

  /**
   * 获取提供商统计
   */
  getProviderStats: async (provider) => {
    const client = await getClient();
    const key = `provider_stats:${provider}`;

    if (!provider) {
      throw new Error("provider 不能为空");
    }

    try {
      const stats = await client.hGetAll(key);

      // 转换数值字段
      const numberFields = [
        "total_requests",
        "total_tokens",
        "cache_hits",
        "total_retries",
      ];
      numberFields.forEach((field) => {
        if (stats[field]) {
          stats[field] = parseInt(stats[field], 10);
        }
      });

      return stats;
    } catch (error) {
      console.error(`获取提供商 ${provider} 统计失败:`, error);
      return {};
    }
  },
};

// ------------------------------
// 业务操作增强
// ------------------------------

const biz = {
  cacheProviderRates: async (rates) => {
    const client = await getClient();

    if (!rates || !Array.isArray(rates)) {
      throw new Error("rates 必须是一个数组");
    }

    return client.set("provider_rates", JSON.stringify(rates), {
      EX: 3600,
    });
  },

  getProviderRates: async () => {
    try {
      const val = await (await getClient()).get("provider_rates");
      return val ? JSON.parse(val) : [];
    } catch (error) {
      console.error("获取提供商费率失败:", error);
      return [];
    }
  },

  incrementVirtualKeyUsage: async (vk, tokens = 0) => {
    const client = await getClient();

    if (!vk) {
      throw new Error("virtual key 不能为空");
    }

    const key = `usage:${vk}`;
    const pipeline = client
      .multi()
      .hIncrBy(key, "request_count", 1)
      .hIncrBy(key, "token_count", tokens)
      .hSet(key, "last_used", new Date().toISOString())
      .expire(key, 86400);

    const results = await pipeline.exec();

    // 检查管道执行结果
    results.forEach((result, index) => {
      if (result instanceof Error) {
        console.error(`虚拟键使用统计管道操作 ${index} 失败:`, result);
      }
    });

    return results;
  },
};

// ------------------------------
// 导出
// ------------------------------

module.exports = {
  connect: getClient,
  kv,
  stream,
  biz,
  monitoring,
  schema: REDIS_SCHEMA,
  healthCheck,
  forceReconnect,
};
