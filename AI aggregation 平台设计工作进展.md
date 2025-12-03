# AI aggregation 平台设计工作进展

## billing / account_balance

### 相关数据表

```sql
CREATE TABLE IF NOT EXISTS data.account_balance
(
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    owner_userid uuid,
    balance numeric DEFAULT 0,
    overdue_amount numeric DEFAULT 0,
    owner_tenantid uuid,
    CONSTRAINT account_balance_pkey PRIMARY KEY (id),
    CONSTRAINT account_balance_user_id_unique UNIQUE (owner_userid),
    CONSTRAINT account_balance_owner_id_fkey FOREIGN KEY (owner_tenantid)
        REFERENCES data.tenant (id) MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE NO ACTION,
    CONSTRAINT account_balance_owner_user_fkey FOREIGN KEY (owner_userid)
        REFERENCES data.user_profile (user_id) MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE NO ACTION
)

CREATE TABLE IF NOT EXISTS data.virtual_key
(
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    virtual_key text COLLATE pg_catalog."default" NOT NULL,
    name text COLLATE pg_catalog."default" NOT NULL,
    description text COLLATE pg_catalog."default",
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    key_type_id uuid,
    key_prefix text COLLATE pg_catalog."default",
    primary_config_node_id uuid,
    config_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    computed_config jsonb,
    CONSTRAINT virtual_key_pkey PRIMARY KEY (id),
    CONSTRAINT virtual_key_virtual_key_key UNIQUE (virtual_key),
    CONSTRAINT virtual_key_primary_config_node_id_fkey FOREIGN KEY (primary_config_node_id)
        REFERENCES data.config_nodes (id) MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE NO ACTION,
    CONSTRAINT virtual_key_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES data.user_profile (user_id) MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE NO ACTION
)

CREATE TABLE IF NOT EXISTS data.user_profile
(
    user_id uuid NOT NULL,
    username text COLLATE pg_catalog."default" NOT NULL,
    tenant_id uuid,
    status text COLLATE pg_catalog."default" DEFAULT 'pending'::text,
    created_at timestamp with time zone DEFAULT now(),
    canceled_at timestamp with time zone,
    customer_type_id uuid,
    CONSTRAINT user_profile_pkey PRIMARY KEY (user_id),
    CONSTRAINT user_profile_username_key UNIQUE (username),
    CONSTRAINT user_profile_customer_type_id_fkey FOREIGN KEY (customer_type_id)
        REFERENCES data.customer_type (id) MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE NO ACTION,
    CONSTRAINT user_profile_tenant_id_fkey FOREIGN KEY (tenant_id)
        REFERENCES data.tenant (id) MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE NO ACTION,
    CONSTRAINT user_profile_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES auth.login (id) MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE NO ACTION
)

CREATE TABLE IF NOT EXISTS data.tenant
(
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text COLLATE pg_catalog."default" NOT NULL,
    contact text COLLATE pg_catalog."default",
    notes text COLLATE pg_catalog."default",
    created_at timestamp without time zone DEFAULT now(),
    default_template_id uuid,
    customer_type_id uuid,
    CONSTRAINT tenant_pkey PRIMARY KEY (id),
    CONSTRAINT tenant_customer_type_id_fkey FOREIGN KEY (customer_type_id)
        REFERENCES data.customer_type (id) MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE NO ACTION
)
```

### 说明

* 一个user_profile 可以有多个virtual_key, user_profile.user_id -> virtual_key.user_id

* user_profile.tenant_id 如果为null, 则为normal_user, 如果user_profile.tenant_id不为空则表示该user属于tenant.id的用户.

* 消费主体: 个人用户和租户. 对于user_profile.tenant_id不为空的, 费用计入tenant. 

* virtual_key 代表一个调用使用者（user）

## 目前已完成相关工作

### 项目结构

```
neuropia_api_gateway/
├── src
│   ├── clients
│   │   ├── postgrest.js
│   │   ├── redis.js
│   │   └── redisSchema.js
│   ├── constants
│   │   └── cacheKeys.js
│   ├── middleware
│   │   ├── errorHandler.js
│   │   ├── requestLogger.js
│   │   └── virtualKey.js
│   ├── routes
│   │   └── proxy.js
│   ├── services
│   │   ├── balanceService.js
│   │   ├── billingService.js
│   │   ├── configCacheManager.js
│   │   ├── configCacheManagerSupa.js.bak
│   │   ├── configService.js
│   │   ├── monitoringService.js
│   │   └── pricingCacheManager.js
```

### 共享的 redisSchema

```js
// ------------------------------
// Redis Key Schema
// ------------------------------

const REDIS_SCHEMA = {
  // --------------------------
  // Streams
  // --------------------------
  STREAMS: {
    USAGE_STREAM: "usage_stream",
    API_MONITORING_STREAM: "api_monitoring_stream",
    ERROR_STREAM: "error_stream",
    NETWORK_ERROR_STREAM: "network_error_stream",
    COST_ANALYSIS_STREAM: "cost_analysis_stream",
  },

  // --------------------------
  // Hashes
  // --------------------------
  HASHES: {
    VIRTUAL_KEY_USAGE: { pattern: "usage:{virtual_key}", ttl: 86400 },
    PROVIDER_STATS: { pattern: "provider_stats:{provider}", ttl: 2592000 },
    DAILY_STATS: { pattern: "stats:daily:{date}", ttl: 604800 },
    USER_COSTS: { pattern: "user_costs:{user_id}", ttl: 2592000 },
    ERROR_STATS: { pattern: "errors:{virtual_key}", ttl: 604800 },
  },

  // --------------------------
  // Sorted Sets
  // --------------------------
  SORTED_SETS: {
    VIRTUAL_KEY_RANKING: "ranking:virtual_keys",
    PROVIDER_RANKING: "ranking:providers",
    MODEL_RANKING: "ranking:models",
    VIRTUAL_KEY_TOTAL_TOKENS: "analytics:virtual_key:total_tokens",
    PROVIDER_TOTAL_TOKENS: "analytics:provider:total_tokens", // 新增
  },

  // --------------------------
  // Strings
  // --------------------------
  STRINGS: {
    PROVIDER_RATES: "provider_rates",
    RATE_LIMITS: "config:rate_limits",
    COST_CONFIG: "config:cost_rates",
  },

  // --------------------------
  // Helper to build keys
  // --------------------------
  buildKey: (pattern, params = {}) => {
    return pattern.replace(/\{(\w+)\}/g, (_, key) => {
      if (!(key in params)) {
        throw new Error(`Missing key param: ${key}`);
      }
      return params[key];
    });
  },
};

module.exports = REDIS_SCHEMA;
````

### monitoringService.js

负责管理 `api_gateway` 对用户请求转发给 `portkey ai gateway` 并获得响应后的usage信息. 

---

#### **全局变量**

| 名称             | 类型     | 说明                                                                |
| -------------- | ------ | ----------------------------------------------------------------- |
| `RedisService` | Object | Redis 客户端封装，提供 `.connect()` 和 `.monitoring.trackApiRequest()` 等方法 |
| `REDIS_SCHEMA` | Object | Redis key schema 常量定义，包括 `HASHES`、`STREAMS`、`SORTED_SETS` 等       |
| `CONFIG`       | Object | 配置常量，包含 `MAX_RETRIES`、`RETRY_DELAY`、`VALIDATION` 子对象等             |

---

#### **函数签名信息**

##### 数据验证相关

```js
function validateMonitoringRecord(record: object) : string[]
function isValidISOString(dateString: string) : boolean
```

##### 重试工具函数

```js
async function executeWithRetry(
    operation: () => Promise<any>, 
    context?: object, 
    maxRetries?: number
) : Promise<any>
```

##### 核心监控函数

```js
async function trackApiRequest(
    userContext: { virtual_key: string, [key: string]: any }, 
    portkeyResponse: Response, 
    responseBody: object, 
    requestBody: object, 
    path?: string
) : Promise<void>

function convertToStreamFormat(record: object) : object
function safeStringify(obj: any) : string
async function fallbackStorage(args: any[], error: Error) : Promise<void>
```

##### 构建监控记录

```js
function buildMonitoringRecord(
    userContext: { virtual_key: string, [key: string]: any }, 
    portkeyResponse: Response, 
    responseBody: object, 
    requestBody: object, 
    path: string
) : object
```

##### 更新统计信息

```js
async function updateVirtualKeyUsage(record: {
    virtual_key: string, 
    usage: { total_tokens: number, prompt_tokens: number, completion_tokens: number, cached_tokens: number }
}) : Promise<void>

async function updateProviderStats(record: {
    provider_info: { provider: string, retry_count?: number }, 
    usage: { total_tokens: number }, 
    performance: { cache_status: string }
}) : Promise<void>

async function updateSortedSets(record: {
    virtual_key?: string, 
    usage: { total_tokens: number }, 
    provider_info?: { provider: string }
}) : Promise<void>
```

##### 错误记录

```js
async function trackError(errorRecord: { virtual_key: string, [key: string]: any }) : Promise<void>
async function trackNetworkError(networkErrorRecord: { network_error?: { path?: string }, [key: string]: any }) : Promise<void>
```

##### 成本分析记录

```js
async function trackCostAnalysis(costRecord: {
    user_id: string, 
    tokens: { total: number, prompt: number, completion: number }, 
    timestamp: string
}) : Promise<void>
```

##### 工具函数

```js
function extractUsageFromResponse(responseBody: object) : {
    prompt_tokens: number, 
    completion_tokens: number, 
    total_tokens: number, 
    cached_tokens: number,
    cache_read_input_tokens?: number,
    cache_creation_input_tokens?: number,
    reasoning_tokens?: number,
    audio_tokens?: number
}

function parseTokens(tokensHeader: string) : { prompt: number, completion: number, total: number }
function collectObservabilityHeaders(response: Response) : object
function generateTraceId() : string
```

### pricingCacheManager.js

负责管理价格矩阵的更新

#### **全局变量**

| 名称                  | 类型                | 说明                                                         |
| --------------------- | ------------------- | ------------------------------------------------------------ |
| `Client`              | Class               | PostgreSQL 客户端（`pg`）                                    |
| `RedisService`        | Object              | Redis 客户端封装，提供 `.kv.get/setex/del()` 等方法          |
| `postgrest`           | Object              | PostgREST 客户端，用于 RPC 调用和查询                        |
| `CACHE_KEYS`          | Object              | Redis 缓存 key 构建工具，包含 `CUSTOMER_TYPE_PRICING`、`VIRTUAL_KEY_PRICING` 等 |
| `DEFAULT_TTL`         | number              | 默认缓存过期时间（秒）                                       |
| `pricingCacheManager` | PricingCacheManager | 单例实例，封装了价格缓存逻辑                                 |

#### **类 `PricingCacheManager`**

##### 构造与初始化

```js
constructor()
async initialize() : Promise<void>
async shutdown() : Promise<void>
```

##### 价格变动处理

```js
async handlePriceChange(ctId: string | number) : Promise<void>
async _invalidateVirtualKeysByCustomerType(ctId: string | number) : Promise<void>
```

##### 缓存操作

```js
async get(customerTypeId: string | number, ttl?: number) : Promise<any>
async refresh(customerTypeId: string | number, ttl?: number) : Promise<any>
async invalidate(customerTypeId: string | number) : Promise<void>
```

#### **外部函数 / 工具函数**

```js
async function getVirtualKeyPricing(
    vk: string, 
    fetchFromDb: (vk: string) => Promise<any>
) : Promise<any>

async function invalidateVirtualKeyPricing(vk: string) : Promise<void>

async function getCustomerTypePricing(
    ctId: string | number, 
    fetchFromDb: (ctId: string | number) => Promise<any>
) : Promise<any>

async function invalidateCustomerTypePricing(ctId: string | number) : Promise<void>
```

------

✅ **说明**

1. `PricingCacheManager` 内部使用 PostgreSQL 的 `LISTEN/NOTIFY` 机制监听 `customer_type_rate_update` 通知，实现价格变动自动刷新缓存。
2. Redis 缓存分为两类：
   - `CUSTOMER_TYPE_PRICING`（按 customer_type 缓存）
   - `VIRTUAL_KEY_PRICING`（按 virtual_key 缓存）
3. 外部函数提供了直接操作虚拟键或 customer_type 的缓存接口，可独立于类实例使用。

### balanceService.js - 开发中代码

#### **全局变量**

| 名称           | 类型   | 说明                                                         |
| -------------- | ------ | ------------------------------------------------------------ |
| `postgrest`    | Object | PostgREST 客户端，用于查询 `api.account_balances` 视图       |
| `RedisService` | Object | Redis 客户端封装，提供 `.kv.get`、`.kv.setex`、`.kv.eval` 等方法 |

#### **类 `BalanceService`**

#### **获取用户余额**

```ts
static async getBalance(userId: string) : Promise<{
    id: string,
    user_id: string,
    username: string,
    tenant_id: string,
    balance: number,
    overdue_amount: number
}>
```

- **功能说明**：
  1. 先从 Redis 缓存获取用户余额。
  2. 如果缓存不存在，则调用 PostgREST 查询 `api.account_balances` 视图，按 `user_id` 精确匹配。
  3. 查询到的结果写入 Redis，缓存有效期 30 秒。
  4. 返回用户余额信息，包括 `balance` 和 `overdue_amount` 等字段。

#### **扣费操作**

```ts
static async chargeUser(
    userId: string, 
    chargeAmount: number
) : Promise<{ ok: number } | { err: "BALANCE_NOT_FOUND" | "INSUFFICIENT_BALANCE" }>
```

- **功能说明**：
  1. 使用 Redis Lua 脚本原子操作执行扣费逻辑。
  2. 检查 Redis 中是否存在余额（`BALANCE_NOT_FOUND` 错误）。
  3. 检查余额是否足够扣费（`INSUFFICIENT_BALANCE` 错误）。
  4. 扣费成功后更新 Redis 中的余额并返回 `{ ok: 新余额 }`。
- **实现细节**：
  - Lua 脚本保证原子性，防止并发扣费导致余额不一致。
  - 当前仅在 Redis 中扣费，异步写回数据库逻辑未实现。

#### **使用示例**

```js
const BalanceService = require('./balanceService');

// 获取用户余额
const balance = await BalanceService.getBalance('user-123');

// 扣费操作
const result = await BalanceService.chargeUser('user-123', 50);
if (result.err) {
    console.error('扣费失败:', result.err);
} else {
    console.log('扣费成功，剩余余额:', result.ok);
}
```

#### **核心流程**

1. **获取余额**
   - Redis 缓存 → 命中直接返回
   - 缓存未命中 → PostgREST 查询 → 写入 Redis → 返回
2. **扣费操作**
   - Redis Lua 脚本原子扣费
   - 检查余额存在与足够性
   - 扣费后更新 Redis

```js
// src/services/balanceService.js
const postgrest = require('../clients/postgrest');
const RedisService = require('@shared/clients/redis_op');

class BalanceService {

    /**
     * 获取用户余额（走 Redis 缓存 + PostgREST）
     */
    static async getBalance(userId) {
        const cacheKey = `balance:${userId}`;
        const cached = await RedisService.kv.get(cacheKey);
        if (cached) {
            return JSON.parse(cached);
        }

        // 此处有问题
        // 调用 PostgREST 的 view: api.account_balances
        const { data, error } = await postgrest
            .from('account_balances')
            .select('*')
            .eq('user_id', userId)
            .single();

        if (error) throw error;

        // 缓 30s refresh
        await RedisService.kv.setex(cacheKey, 30, JSON.stringify(data));

        return data;
    }


    /**
     * 扣费（Redis 原子操作，异步写回 DB）
     * chargeAmount = 预计 token 消耗 * price
     */
    static async chargeUser(userId, chargeAmount) {
        const balanceKey = `balance:${userId}`;

        return await RedisService.kv.eval(`
            local key = KEYS[1]
            local charge = tonumber(ARGV[1])
            local bal = redis.call("GET", key)

            if not bal then
                return {err="BALANCE_NOT_FOUND"}
            end

            bal = cjson.decode(bal)

            if bal.balance < charge then
                return {err="INSUFFICIENT_BALANCE"}
            end

            bal.balance = bal.balance - charge
            redis.call("SET", key, cjson.encode(bal))
            return { ok = bal.balance }
        `, 1, balanceKey, chargeAmount);
    }
}

module.exports = BalanceService;

```



### billingService.js - 开发中代码

```js
const BalanceService = require('./balanceService');

// 简易计费逻辑：每次请求扣 0.0001 美元
// 后续可从 result 中读取 token_usage 等真实扣费
async function deductCost(virtual_key, portkeyResult, path) {
    const cost = 0.0001;

    const newBalance = await BalanceService.deduct(virtual_key, cost);
    console.log(`💳 已扣费 ${cost}, 新余额 = ${newBalance}`);
}

module.exports = { deductCost };
```

## 网关主控流程代码文件

### **proxy.js 代码说明（Neuropia API Gateway）**

#### **全局变量**

| 名称                  | 类型     | 说明                                               |
| --------------------- | -------- | -------------------------------------------------- |
| `express`             | Object   | Express 框架                                       |
| `router`              | Object   | Express Router 实例，用于定义 `/v1/*` 请求代理路由 |
| `portkeyConfigSchema` | Object   | Portkey 配置结构验证 schema（zod）                 |
| `ConfigService`       | Object   | 配置服务，用于获取 virtual_key 配置                |
| `deductCost`          | Function | 扣费服务函数（当前未启用）                         |
| `BalanceService`      | Object   | 用户余额服务                                       |
| `trackApiRequest`     | Function | 监控记录函数，用于记录 API 调用信息                |
| `trackError`          | Function | 错误监控记录函数                                   |

#### **路由说明**

##### **统一代理 `/v1/\*` 请求**

```ts
router.all('/*', async (req, res))
```

- **功能**：
  1. 获取 `userContext` 和请求体 `requestBody`。
  2. 调用 `ConfigService.getAllConfigs` 获取完整 virtual_key 配置。
  3. 校验业务规则，包括：
     - 模型访问权限检查
     - 预算检查（`checkBudget`，未完全实现）
     - 限流检查（`checkRateLimits`，未完全实现）
  4. 调用 Portkey Gateway 进行请求转发。
  5. 返回 Portkey 响应。
  6. 统一错误处理，包括模型未允许、频率限制、数据库或其它内部错误。
- **错误处理**：
  - 403：模型不在允许列表中
  - 429：频率超限
  - 500：内部错误（包括虚拟 key 配置错误）

#### **辅助函数**

##### **validateBusinessRules(metadata, userContext, requestBody, path)**

- **功能**：
  1. 校验模型权限（`allowed_models`）
  2. 预算检查（`budget`，调用 `checkBudget`）
  3. 限流检查（`rate_limits`，调用 `checkRateLimits`）
- **参数**：
  - `metadata`：Portkey 配置中 `_neuropia.sync_controls` 元数据
  - `userContext`：用户上下文，包含 `virtual_key`
  - `requestBody`：请求体
  - `path`：请求路径

##### **checkBudget(budgetConfig, userContext, requestBody, path)**

- **功能**：
  1. 调用 `BalanceService.getBalance` 获取用户余额。
  2. 比较用户余额与最小请求所需余额（`budgetConfig.minimum_required`）。
  3. 余额不足则抛出错误。
- **返回**：
  - 成功返回 `true`
  - 失败抛出错误

##### **checkRateLimits(rateLimits, userContext, requestBody, path)**

- **功能**：
  - 计划通过 Redis 原子操作进行限流检查
  - 当前仅输出日志

##### **callPortkeyGateway(config, requestBody, userContext, path)**

- **功能**：
  1. 根据 Portkey 配置调用 Gateway。
  2. 使用 `portkeyConfigSchema` 验证配置结构。
  3. POST 请求到 Gateway，带上配置和元数据头。
  4. 如果响应非 2xx，记录错误到监控系统 (`trackError`)。
  5. 成功返回 JSON 响应。
  6. 同时触发监控记录 (`trackApiRequest`)。
  7. 扣费逻辑调用（`deductCost`）暂未启用。

##### **getFallbackConfig(userContext, requestBody)**

- **功能**：
  - 当配置获取失败时，提供降级默认配置：
    - 单一策略 `mode: "single"`
    - 使用环境变量指定的 fallback provider / api_key / model
    - 默认 metadata，包括预算、模型访问权限和限流策略

#### **核心流程**

1. **请求入口**：所有 `/v1/*` 请求通过 `router.all` 捕获
2. **获取配置**：
   - 调用 `ConfigService.getAllConfigs`
   - 若失败 → 使用 `getFallbackConfig`
3. **校验业务规则**：
   - 模型访问权限
   - 预算（未启用）
   - 限流（未启用）
4. **调用 Portkey Gateway**：
   - 通过 `callPortkeyGateway` 发送 POST 请求
   - 验证配置结构
   - 记录监控信息
5. **返回结果或错误**：
   - 错误包括 403、429、500
   - 成功返回 Portkey Gateway 响应

#### **使用示例**

```js
// neuropia_api_gateway/src/app.js
const express = require('express');
const proxyRouter = require('./routes/proxy');

const app = express();
app.use(express.json());
app.use("/v1", proxyRouter);

app.listen(3000, () => {
  console.log("Neuropia API Gateway running on port 3000");
});
```

- 发送请求 `/v1/chat/completions` → 通过代理路由 → 转发到 Portkey Gateway → 返回响应 → 记录监控

# Todo

完成billing/account_balance的代码, 目前已知的

## 流程设计

```
User Request
     |
     v
API Gateway (proxy.js)
     |
     |-- validateBusinessRules()
     |        |
     |        |-- checkBudget()  --> 如果余额<=0 直接拒绝
     |
     v
Call Portkey Gateway
     |
     v
Model Response (tokens usage)
     |
     v
trackApiRequest()
     |
     |-- 从 usage 计算 cost
     |-- balance -= cost  (原子扣费)
     |
     v
Return result to user
```

因为它：

* **不需要预扣费**

（最大可能消耗不准、也没必要）

* **请求开始时检查余额 → 防止透支**

（一分钱都不能借）

* **请求结束后根据真实 tokens 使用扣费 → 精准无误**

* **不需要改 Portkey Gateway**

​	全部在 API Gateway 层完成

* **价格缓存机制依然有用 + 但现在重新找到位置（扣费时使用）**

## 定价与余额

定价与余额要按「实例」来算，而不是用户。

* 什么是付费主体（billing entity）？
  	
  
  1. user(个人用户)
  
  2. tenant(企业)
  
     
  
* 谁来消费？

​	virtual_key 代表一个调用使用者（user）

* 谁来付费？

​	如果 user_profile.tenant_id 不为空 → 付费主体是 tenant,  否则 → 付费主体是 user_profile

​	所以 balance 的读取逻辑应该是, (nodejs代码, 实际应该放数据库函数)

```js
function resolveBillingAccount(vk):
    user_id = lookup virtual_key -> user_id
    user = get user_profile
    if user.tenant_id != null:
        return account_balance where owner_tenant_id = user.tenant_id
    else:
        return account_balance where owner_user_id = user.user_id
```

我们现在持久层架构的基础是 postgrest + pg, crud应该走数据库控制.

# 最终实现

### 1. 目标

确保在代理请求过程中：

1. 能正确查出虚拟 key 对应的实际扣费账户（user 或 tenant）。
2. 查询账户余额，并保证 Redis 缓存。
3. 扣费时用 Lua 脚本保证原子性。
4. 扣费完成后更新 Redis 缓存和日志/监控。

------

### 2. 核心流程

#### Step 1: 解析账单账户 (`resolveBillingAccount`)

- 输入：`virtual_key`
- 流程：
  1. 从 Redis 缓存读取，如果存在直接返回。
  2. 查 `virtual_keys` 表获取 `user_id`。
  3. 查 `user_profiles` 表获取 `tenant_id`。
  4. 决定账单主体：
     - 如果有 `tenant_id` → 账单类型 = tenant
     - 否则 → 账单类型 = user
  5. 查 `account_balances` 表获取账户数据。
  6. 写入 Redis 缓存。
- 输出：

```js
{
  id: billingId,       // tenantId 或 userId
  type: "tenant"|"user",
  account: accountData // { balance, overdue_amount, ... }
}
```

------

#### Step 2: 确保 Redis 缓存 (`ensureCache`)

- 输入：`account`（`resolveBillingAccount` 返回结果）
- 流程：
  1. 构造 Redis key：`CACHE_KEYS.BALANCE(account.type, account.id)`
  2. 读取 Redis，如果存在返回缓存。
  3. 缓存不存在时，用 `account.account` 写入 Redis（TTL 30 秒）。
- 输出：账户余额对象。

------

#### Step 3: 查询余额 (`getBalanceByAccount`)

- 输入：`account`（账单主体）
- 流程：
  1. 先读 Redis 缓存。
  2. 缓存不存在时，查 `account_balance` 表。
  3. 写入 Redis 缓存。
- 输出：账户余额对象。

------

#### Step 4: 扣费 (`chargeAccount`)

- 输入：`account`、`chargeAmount`
- 流程：
  1. 构造 Redis key。
  2. Lua 脚本：
     - 获取当前余额。
     - 检查余额是否足够。
     - 扣除金额。
     - 写回 Redis。
     - 返回剩余余额或错误。
- 输出：`{ ok: newBalance }` 或 `{ err: "错误类型" }`

------

#### Step 5: 一步完成扣费 (`chargeUser`)

- 输入：`virtual_key`、`chargeAmount`
- 流程：
  1. 调用 `resolveBillingAccount` 获取账单主体。
  2. 调用 `ensureCache` 确保 Redis 缓存。
  3. 调用 `chargeAccount` 扣费。
- 输出：扣费结果（余额或错误）。

------

#### Step 6: 代理请求中的扣费 (`chargeUserAfterRequest`)

- 输入：`virtual_key`、`portkeyResult`
- 流程：
  1. 计算消耗 token 对应的费用。
  2. 调用 `BalanceService.chargeUser` 扣费。
  3. 打印日志或警告。

------

### 3. Redis 缓存策略

- 账单账户缓存：
  - Key: `CACHE_KEYS.BILLING_ACCOUNT(virtual_key)` → `{ id, type, account }`
- 余额缓存：
  - Key: `CACHE_KEYS.BALANCE(account.type, account.id)` → `{ balance, overdue_amount, ... }`
  - TTL: 30 秒
- Lua 脚本保证扣费原子性。

------

### 4. 错误处理

- 未找到虚拟 key → `VIRTUAL_KEY_NOT_FOUND`
- 未找到用户 → `USER_NOT_FOUND`
- 未找到账户 → `ACCOUNT_NOT_FOUND`
- 余额不足 → `INSUFFICIENT_BALANCE`
- Redis 缓存或 Lua 参数错误 → 报错并停止执行

------

如果你需要，我可以顺便写一个“文字流程+方法对应关系表”，方便对照你代码里每个函数的职责，不带任何图表。

你希望我做吗？
