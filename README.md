## 📋 Neuropia AI 平台 MVP 设计文档

# Neuropia AI 平台 - MVP 设计文档

## 🎯 核心业务模型

**AI 服务批发商模式**：

```
平台 API Keys (批发价) → Neuropia平台 (加价) → 客户 Virtual Keys (零售价)
```

## 🏗️ 系统架构

### 服务组件

```mermaid
graph TB
    C[客户端] --> G[API Gateway:3001]
    G --> CS[Config Service:3002]
    G --> P[Portkey Gateway:8787]
    CS --> R[Redis]
    CS --> PG[PostgreSQL+PostgREST:3000]
    P --> A[AI Providers]
```

### 数据流

1. **客户端** → `x-virtual-key` → **API Gateway**
2. **API Gateway** → 验证 → **Config Service** (获取配置)
3. **Config Service** → 生成 → **Portkey 配置**
4. **API Gateway** → 转发 → **Portkey Gateway**
5. **Portkey Gateway** → 调用 → **AI 提供商**
6. **API Gateway** → 记录 → **使用量和计费**

## 🗄️ 核心数据库设计

### 关键表结构

```sql
-- 用户认证
auth.login (id, email, hashed_password, role)

-- 用户资料
data.user_profile (user_id, username, tenant_id, status, balance)

-- 虚拟密钥
data.virtual_key (virtual_key, user_id, rate_limits, allowed_models, is_active)

-- 提供商费率
data.provider_rate (provider, model, input_rate, output_rate, currency)

-- Portkey 配置
data.portkey_configs (config_json, user_id, is_active)

-- 使用记录
data.usage_log (user_id, provider, model, tokens, cost)
```

## 🔐 认证与授权

### 三级权限体系

1. **平台认证** - JWT Token (`Authorization: Bearer <token>`)
2. **Virtual Key** - 客户标识 (`x-virtual-key: vk_xxx`)
3. **模型权限** - 基于 Virtual Key 的模型白名单

## 💰 计费系统

### 成本计算

```javascript
// 平台成本
platformCost = inputTokens * inputRate + outputTokens * outputRate;

// 客户收费
customerCharge = platformCost * (1 + markupPercent);

// 实时扣费
await deductBalance(userId, customerCharge);
```

### 状态管理

```
pending → (充值) → active → (余额≤0) → overdue → (充值≥阈值) → active
```

## 🔧 核心技术栈

### 后端服务

- **Node.js + Express** - 两个核心服务
- **PostgreSQL** - 主数据库
- **PostgREST** - 自动 REST API
- **Redis** - 配置缓存和会话

### AI 集成

- **Portkey Gateway** - AI 路由和聚合
- **阿里云百炼** - 主要 AI 提供商
- **OpenAI/Anthropic** - 备用提供商

## 🚀 MVP 核心功能

### 已实现功能

- [x] 用户注册和认证系统
- [x] Virtual Key 管理和验证
- [x] 动态 Portkey 配置生成
- [x] 阿里云百炼集成
- [x] 使用量追踪和计费
- [x] 多租户隔离
- [x] 速率限制

### 服务端点

```
POST /api/chat/completions      # AI 聊天（需 Virtual Key）
GET  /api/config/virtual-keys/:key  # 配置查询
POST /api/users/:userId/virtual-keys  # 密钥管理
GET  /health                   # 健康检查
```

## ⚙️ 配置管理

### Config Service 职责

- 生成 Portkey 配置 (`x-portkey-config`)
- 管理模型到提供商的映射
- 缓存热点数据到 Redis
- 监听数据库配置变更

### 动态配置示例

```json
{
  "strategy": { "mode": "fallback" },
  "targets": [
    {
      "provider": "dashscope",
      "virtual_key": "vk_client_123",
      "api_key": "平台密钥",
      "override_params": { "model": "qwen-turbo" }
    }
  ],
  "metadata": {
    "user_id": "user_123",
    "virtual_key": "vk_client_123"
  }
}
```

## 🔄 关键业务流程

### 1. 用户注册流程

```
注册 → 充值 → 激活 → 创建 Virtual Key → 开始使用
```

### 2. AI 调用流程

```
验证 Virtual Key → 检查余额 → 生成配置 →
调用 Portkey → 记录使用量 → 扣费 → 返回结果
```

### 3. 配置更新流程

```
数据库变更 → PG 通知 → Config Service →
更新 Redis → 新请求使用新配置
```

## 📊 数据模型关系

```
用户 (1) ←→ (多) Virtual Keys
用户 (1) ←→ (1) 余额
Virtual Key (多) ←→ (多) 允许的模型
使用记录 (多) → (1) 用户
```

## 🎯 下一步重点

### 高优先级

1. 完整的端到端测试
2. 阿里云百炼 API 集成验证
3. 计费系统准确性测试
4. 错误处理和重试机制

### 中优先级

1. 监控和日志系统
2. 管理后台功能
3. 更多 AI 提供商集成
4. 性能优化

## 💡 重要设计决策

1. **配置与业务分离** - Config Service 独立存在
2. **Virtual Key 作为业务标识** - 不暴露平台 API Keys
3. **实时计费** - 每次调用立即扣费
4. **负余额允许** - 用户体验优先，但限制后续调用
5. **数据库为中心** - 所有配置持久化，Redis 作为缓存

# portkey gateway 参考信息

项目地址: https://github.com/Portkey-AI/gateway

源码文档: https://deepwiki.com/Portkey-AI/gateway

# 📁 Neuropia AI 平台 - 完整目录结构说明

# Neuropia AI 平台 - 项目目录结构

## 🏗️ 整体项目结构

```
neuropia-platform/
├── 🚀 neuropia_api_gateway/          # 业务网关服务 (端口:3001)
├── ⚙️ neuropia_config_service/       # 配置管理服务 (端口:3002)
├── 🔗 shared/                        # 共享工具和配置
├── 🧪 tests/                         # 完整测试套件
├── 🐳 docker-compose.yml             # 开发环境容器编排
├── 📋 PROJECT_CONTEXT.md             # 项目上下文文档
└── 🔧 .env.example                   # 环境变量模板

```

## 🚀 neuropia_api_gateway/ - 业务网关服务

```
neuropia_api_gateway/
├── 📁 src/
│   ├── 🏗️ app.js                     # 主应用入口，Express服务器配置
│   ├── 📁 middleware/                # 中间件层
│   │   ├── 🔐 auth.js                # JWT认证中间件
│   │   └── 🔑 virtualKey.js          # Virtual Key验证中间件
│   ├── 📁 routes/                    # API路由
│   │   ├── 💬 chat.js                # AI聊天端点 (POST /api/chat/completions)
│   │   ├── ⚙️ config.js              # 配置查询端点
│   │   └── 👥 users.js               # 用户管理端点
│   ├── 📁 services/                  # 业务逻辑服务
│   │   ├── 💰 billingService.js      # 计费和费率计算
│   │   ├── 🔧 configService.js       # 配置服务客户端
│   │   ├── 👤 userService.js         # 用户管理和权限检查
│   │   └── 🗄️ redisService.js        # Redis缓存操作 (读取为主)
│   └── 🚀 server.js                  # 服务启动脚本
├── 📦 package.json                   # Node.js依赖和脚本
└── 🐳 Dockerfile                     # 容器化配置
```

### 核心职责：

- ✅ 处理所有客户端API请求
- ✅ Virtual Key验证和用户权限检查
- ✅ 调用Config Service生成Portkey配置
- ✅ 转发请求到Portkey Gateway
- ✅ 使用量记录和实时计费
- ✅ 速率限制和访问控制

## ⚙️ neuropia_config_service/ - 配置管理服务

```
neuropia_config_service/
├── 📁 src/
│   ├── 🏗️ app.js                     # 主应用入口
│   ├── 📁 services/                  # 核心服务
│   │   ├── 🗄️ redisService.js        # Redis缓存操作 (读写)
│   │   ├── 🔧 configManager.js       # 配置加载和管理
│   │   └── 🎯 portkeyConfigGenerator.js # Portkey配置生成器
│   ├── 📁 listeners/                 # 数据库监听
│   │   └── 👂 pgListener.js          # PostgreSQL变更通知监听
│   └── 🚀 server.js                  # 服务启动脚本
├── 📦 package.json                   # Node.js依赖和脚本
└── 🐳 Dockerfile                     # 容器化配置
```

### 核心职责：

- ✅ 管理所有动态配置
- ✅ 生成Portkey Gateway配置
- ✅ 缓存热点数据到Redis
- ✅ 监听数据库配置变更
- ✅ 提供商模型映射管理

## 🔗 shared/ - 共享工具和配置

```
shared/
├── 📁 database/
│   └── db.sql    # 所有数据库schema内容
├── 📁 types/
│   └── index.js                      # 通用类型定义 (VirtualKeyConfig, UserContext等)
└── 📁 utils/
    └── logger.js                     # 统一日志工具
```

### 核心职责：

- ✅ 数据库Schema版本管理
- ✅ 通用类型定义
- ✅ 工具函数和日志配置

## 🧪 tests/ - 测试套件

```
tests/
├── 📁 integration/                   # 集成测试
│   ├── gateway.test.js               # API网关集成测试
│   ├── config.test.js                # 配置服务集成测试
│   ├── virtualKey.test.js            # Virtual Key生命周期测试
│   └── dashscope.test.js             # 阿里云百炼集成测试
├── 📁 e2e/                           # 端到端测试
│   └── fullWorkflow.test.js          # 完整业务流程测试
└── 📁 setup/
    └── dashscope-setup.js            # 测试环境配置
```

### 核心职责：

- ✅ 服务集成测试
- ✅ 业务流程验证
- ✅ 提供商集成测试

## 🐳 基础设施配置

```
docker-compose.yml                    # 开发环境服务编排
├── 🗄️ postgres:5432                 # PostgreSQL数据库
├── 🔄 postgrest:3000                # PostgREST自动API
├── 🗂️ redis:6379                    # Redis缓存
├── 🚀 neuropia_api_gateway:3001     # 业务网关
├── ⚙️ neuropia_config_service:3002  # 配置服务
└── 🌐 portkey_gateway:8787          # Portkey Gateway
```

## 🔑 核心环境变量

```bash
# 数据库
DATABASE_URL=postgresql://postgres:password@localhost:5432/neuropia
POSTGREST_URL=http://localhost:3000

# Redis
REDIS_URL=redis://localhost:6379

# 服务端口
API_GATEWAY_PORT=3001
CONFIG_SERVICE_PORT=3002

# AI提供商API Keys
DASHSCOPE_API_KEY=your_dashscope_key      # 阿里云百炼
OPENAI_API_KEY=your_openai_key           # OpenAI
ANTHROPIC_API_KEY=your_anthropic_key     # Anthropic

# Portkey配置
PORTKEY_GATEWAY_URL=http://localhost:8787
PORTKEY_API_KEY=your_portkey_key
```

## 🔄 关键数据流文件

### 请求处理流程涉及文件：

1. **入口**: `neuropia_api_gateway/src/app.js`
2. **认证**: `middleware/auth.js` → `middleware/virtualKey.js`
3. **业务**: `routes/chat.js` → `services/configService.js`
4. **配置**: `neuropia_config_service/services/portkeyConfigGenerator.js`
5. **计费**: `services/billingService.js` → `services/userService.js`

### 配置管理流程涉及文件：

1. **启动**: `neuropia_config_service/src/server.js`
2. **初始化**: `services/configManager.js`
3. **缓存**: `services/redisService.js`
4. **监听**: `listeners/pgListener.js`

## 🎯 核心业务逻辑分布

### 用户管理

- `userService.js` - 用户权限和余额检查
- `routes/users.js` - 用户API端点
- `data.user_profile` - 用户状态存储

### Virtual Key系统

- `virtualKey.js` - 验证中间件
- `data.virtual_key` - Virtual Key存储
- `userService.js` - Virtual Key管理

### 计费系统

- `billingService.js` - 费率计算和扣费
- `data.provider_rate` - 费率配置
- `data.usage_log` - 使用记录
- `data.account_balance` - 余额管理

### AI集成

- `portkeyConfigGenerator.js` - Portkey配置生成
- `data.model_configs` - 模型提供商映射
- `routes/chat.js` - AI请求处理

您说得对！`create_virtual_key` 已经有完整的通知机制了。让我更新总结表格：

# Virtual Key & Config 相关数据库函数总结

## 📋 函数总览表

### **Virtual Key 管理函数**（全部完整）

| 函数名称                 | 参数                                                                                                                                   | 返回值                   | 通知通道             | 描述                      | 状态        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------- | ------------------------- | ----------- |
| `create_virtual_key`     | `p_user_id, p_name, p_description, p_rate_limit_rpm, p_rate_limit_tpm, p_allowed_models, p_key_type_id, p_key_prefix`                  | `text` (virtual_key)     | `virtual_key_update` | 创建新的Virtual Key       | ✅ **完整** |
| `update_virtual_key`     | `p_virtual_key, p_name, p_description, p_rate_limit_rpm, p_rate_limit_tpm, p_allowed_models, p_key_type_id, p_key_prefix, p_is_active` | `void`                   | `virtual_key_update` | 更新Virtual Key配置       | ✅ **完整** |
| `deactivate_virtual_key` | `p_virtual_key, p_reason`                                                                                                              | `void`                   | `virtual_key_update` | 停用Virtual Key           | ✅ **完整** |
| `activate_virtual_key`   | `p_virtual_key, p_reason`                                                                                                              | `void`                   | `virtual_key_update` | 重新激活Virtual Key       | ✅ **完整** |
| `rotate_virtual_key`     | `p_old_virtual_key, p_reason`                                                                                                          | `text` (new_virtual_key) | `virtual_key_update` | 轮换密钥（停用旧+创建新） | ✅ **完整** |

### **Portkey 配置管理函数**（全部完整）

| 函数名称                    | 参数                                                                                            | 返回值             | 通知通道        | 描述                  | 状态        |
| --------------------------- | ----------------------------------------------------------------------------------------------- | ------------------ | --------------- | --------------------- | ----------- |
| `create_portkey_config`     | `p_tenant_id, p_user_id, p_config_name, p_config_json, p_effective_from, p_notes, p_created_by` | `uuid` (config_id) | `config_update` | 创建Portkey配置       | ✅ **完整** |
| `update_portkey_config`     | `p_id, p_config_json, p_effective_from, p_notes, p_updated_by`                                  | `uuid` (config_id) | `config_update` | 更新Portkey配置       | ✅ **完整** |
| `deactivate_portkey_config` | `p_id, p_reason, p_deactivated_by`                                                              | `void`             | `config_update` | 停用Portkey配置       | ✅ **完整** |
| `activate_portkey_config`   | `p_id, p_reason, p_activated_by`                                                                | `void`             | `config_update` | 激活Portkey配置       | ✅ **完整** |
| `get_active_portkey_config` | `p_tenant_id, p_user_id`                                                                        | `jsonb`            | 无              | 获取生效的Portkey配置 | ✅ 查询函数 |

## 🎯 Service 代码检查要点

### **Config Service 必须实现：**

```javascript
// 监听通道
const CHANNELS = ["config_update", "virtual_key_update"];

// 处理 virtual_key_update 通知
const handleVirtualKeyUpdate = (payload) => {
  const cacheKey = `virtual_key:${payload.virtual_key}`;

  switch (payload.action) {
    case "create":
    case "update":
    case "activate":
      // 创建/更新/激活：设置缓存
      redis.set(
        cacheKey,
        JSON.stringify({
          user_id: payload.user_id,
          virtual_key_id: payload.virtual_key_id,
          rate_limits: payload.rate_limits,
          allowed_models: payload.allowed_models,
          key_type_id: payload.key_type_id,
          key_prefix: payload.key_prefix,
        }),
      );
      break;

    case "deactivate":
      // 停用：删除缓存
      redis.del(cacheKey);
      break;
  }
};

// 处理 config_update 通知
const handleConfigUpdate = (payload) => {
  const cacheKey = `portkey_config:${payload.config_id}`;

  switch (payload.action) {
    case "create":
    case "update":
    case "activate":
      // 设置配置缓存
      redis.set(cacheKey, JSON.stringify(payload.config_json));
      break;

    case "deactivate":
      // 删除配置缓存
      redis.del(cacheKey);
      break;
  }
};
```

### **API Gateway 依赖的缓存数据：**

1. **Virtual Key 验证**：

   ```javascript
   // 检查 virtual_key:{virtual_key} 缓存
   const keyConfig = await redis.get(`virtual_key:${virtualKey}`);
   if (!keyConfig) {
     // 缓存未命中，可能密钥不存在或已停用
     throw new Error("Invalid virtual key");
   }
   ```

2. **Portkey 配置获取**：
   ```javascript
   // 获取 portkey_config:{config_id} 缓存
   const portkeyConfig = await redis.get(`portkey_config:${configId}`);
   ```

## ✅ 状态总结

**所有关键函数都已完备：**

- ✅ **5个 Virtual Key 管理函数** - 完整的增删改查+轮换
- ✅ **4个 Portkey 配置管理函数** - 完整的生命周期管理
- ✅ **全部包含实时通知机制** - 确保缓存一致性
- ✅ **通知payload完整** - 包含所有必要字段

Config Service 现在只需要实现上述监听逻辑，就能保证系统的实时配置同步。

# 服务端代码使用postgresql客户端规范

何时选择 @supabase/postgrest-js：

操作主要是对数据表进行 CRUD（增删改查）。

需要通过 URL 参数进行过滤、分页、排序等操作。

调用的数据库函数比较简单，可以通过 /rpc 端点方便地调用。

希望快速开发，避免手动编写大量数据访问层代码。

何时选择 pg：

你需要执行复杂的多表关联查询或使用 PostgreSQL 特有的高级功能（如特定窗口函数）。

你的操作必须在数据库事务中完成，以确保数据一致性。

你需要更精细地控制数据库连接池。

你追求极致的性能和高吞吐量，希望减少网络开销。

混用策略：
在实际项目中，你也可以考虑混合使用。例如，对于项目中绝大部分简单的配置信息查询，使用 @supabase/postgrest-js 来提升开发效率；而对于像初始化缓存、批量更新等需要事务保证的复杂操作，则使用 pg 来完成。

# pg_dump

```
pg_dump -s -d neuropia --no-comments --exclude-schema=public > schema.sql
```
