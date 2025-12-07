const { createClient } = require("redis");
const REDIS_SCHEMA = require("./redisSchema");

let client = null;
let connecting = false;
let connectionErrors = 0;
const MAX_CONNECTION_ERRORS = 5;

// ------------------------------
// Redis 连接管理
// ------------------------------
async function getClient() {
  if (!client) {
    if (connecting) {
      await new Promise((r) => setTimeout(r, 100));
      return getClient();
    }
    connecting = true;
    try {
      console.log("🔄 创建 Redis 连接");
      client = createClient({
        url: process.env.REDIS_URL || "redis://localhost:6379",
        socket: {
          reconnectStrategy: (retries) => Math.min(retries * 50, 2000),
          connectTimeout: 10000,
          lazyConnect: true,
        },
        pingInterval: 30000,
      });

      client.on("error", (err) => {
        console.error("Redis 错误:", err);
        connectionErrors++;
        if (connectionErrors >= MAX_CONNECTION_ERRORS) {
          console.error("Redis 连接错误次数过多");
        }
      });

      client.on("connect", () => (connectionErrors = 0));
      client.on("ready", () => (connectionErrors = 0));

      await client.connect();
      console.log("✅ Redis 连接成功");
    } finally {
      connecting = false;
    }
  }
  return client;
}

// ------------------------------
// 健康检查 & 强制重连
// ------------------------------
async function healthCheck() {
  try {
    const c = await getClient();
    await c.ping();
    return { status: "healthy", timestamp: new Date(), connectionErrors };
  } catch (err) {
    return {
      status: "unhealthy",
      error: err.message,
      timestamp: new Date(),
      connectionErrors,
    };
  }
}

async function forceReconnect() {
  if (client) {
    try {
      await client.quit();
    } catch {}
    client = null;
  }
  connectionErrors = 0;
  return getClient();
}

// ------------------------------
// KV 操作
// ------------------------------
const kv = {
  get: async (key) => (await getClient()).get(key),
  setex: async (key, ttl, val) => (await getClient()).setEx(key, ttl, val),
  keys: async (pattern) => (await getClient()).keys(pattern),
  del: async (...keys) => (await getClient()).del(keys),
  exists: async (key) => (await getClient()).exists(key),
  eval: async (script, keys = [], args = []) => {
    const c = await getClient();
    // 保证 args 都是 string
    const stringArgs = args.map((a) => (typeof a === "number" ? String(a) : a));
    return c.eval(script, { keys, arguments: stringArgs });
  },
};

// ------------------------------
// Stream 操作
// ------------------------------
const stream = {
  xadd: async (streamKey, id = "*", fields = {}) => {
    const c = await getClient();
    const validatedFields = {};
    for (const k in fields)
      validatedFields[k] = fields[k] != null ? String(fields[k]) : "";
    return c.xAdd(streamKey, id, validatedFields);
  },
  xread: async (streamKey, lastId = "$", blockMs = 5000) =>
    (await getClient()).xRead(
      { key: streamKey, id: lastId },
      { BLOCK: blockMs },
    ),
  xlen: async (streamKey) => (await getClient()).xLen(streamKey),
  xrange: async (streamKey, start = "-", end = "+", count = 100) =>
    (await getClient()).xRange(streamKey, start, end, { COUNT: count }),
};

// ------------------------------
// Monitoring 操作
// ------------------------------
const monitoring = {
  trackApiRequest: async (data) => {
    if (!data.virtual_key) throw new Error("virtual_key 不能为空");
    return (await getClient()).xAdd(
      REDIS_SCHEMA.STREAMS.API_MONITORING_STREAM,
      "*",
      data,
    );
  },

  updateVirtualKeyStats: async (vk, stats) => {
    if (!vk) throw new Error("virtualKey 不能为空");
    const key = REDIS_SCHEMA.buildKey(
      REDIS_SCHEMA.HASHES.VIRTUAL_KEY_USAGE.pattern,
      { virtual_key: vk },
    );
    const c = await getClient();
    const pipeline = c
      .multi()
      .hIncrBy(key, "request_count", stats.request_count || 1)
      .hIncrBy(key, "total_tokens", stats.total_tokens || 0)
      .hIncrBy(key, "prompt_tokens", stats.prompt_tokens || 0)
      .hIncrBy(key, "completion_tokens", stats.completion_tokens || 0)
      .hIncrBy(key, "cached_tokens", stats.cached_tokens || 0);

    if (stats.last_used) pipeline.hSet(key, "last_used", stats.last_used);
    if (stats.total_tokens)
      pipeline.zIncrBy(
        REDIS_SCHEMA.SORTED_SETS.VIRTUAL_KEY_RANKING,
        stats.total_tokens,
        vk,
      );
    pipeline.expire(key, REDIS_SCHEMA.HASHES.VIRTUAL_KEY_USAGE.ttl);

    return pipeline.exec();
  },

  updateProviderStats: async (provider, stats) => {
    if (!provider) throw new Error("provider 不能为空");
    const key = REDIS_SCHEMA.buildKey(
      REDIS_SCHEMA.HASHES.PROVIDER_STATS.pattern,
      { provider },
    );
    const c = await getClient();
    const pipeline = c
      .multi()
      .hIncrBy(key, "total_requests", stats.requests || 1)
      .hIncrBy(key, "total_tokens", stats.tokens || 0);

    if (stats.cache_hit) pipeline.hIncrBy(key, "cache_hits", 1);
    if (stats.retry_count)
      pipeline.hIncrBy(key, "total_retries", stats.retry_count);
    if (stats.tokens)
      pipeline.zIncrBy(
        REDIS_SCHEMA.SORTED_SETS.PROVIDER_RANKING,
        stats.tokens,
        provider,
      );
    pipeline.expire(key, REDIS_SCHEMA.HASHES.PROVIDER_STATS.ttl);

    return pipeline.exec();
  },

  trackError: async (vk, errorData) => {
    if (!vk) throw new Error("virtualKey 不能为空");
    if (!errorData || typeof errorData !== "object")
      throw new Error("errorData 必须是对象");
    const key = REDIS_SCHEMA.buildKey(REDIS_SCHEMA.HASHES.ERROR_STATS.pattern, {
      virtual_key: vk,
    });
    const c = await getClient();
    return c
      .multi()
      .xAdd(REDIS_SCHEMA.STREAMS.ERROR_STREAM, "*", errorData)
      .hIncrBy(key, errorData.status_code || "unknown", 1)
      .exec();
  },
};

// ------------------------------
// Biz 操作
// ------------------------------
const biz = {
  cacheProviderRates: async (rates) => {
    if (!Array.isArray(rates)) throw new Error("rates 必须是数组");
    return (await getClient()).set(
      REDIS_SCHEMA.STRINGS.PROVIDER_RATES,
      JSON.stringify(rates),
      { EX: 3600 },
    );
  },
  getProviderRates: async () => {
    const val = await (
      await getClient()
    ).get(REDIS_SCHEMA.STRINGS.PROVIDER_RATES);
    return val ? JSON.parse(val) : [];
  },
};

// ------------------------------
// Export
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
