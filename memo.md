# 不带model请求

```
curl -X POST http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer vk_908782e38b24598fb24da818eea36ef2" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "Hello, how are you?"}
    ]
  }'
{"choices":[{"message":{"role":"assistant","content":"Hello! I'm just a virtual assistant, so I don't have feelings, but I'm here and ready to help you with anything you need. How can I assist you today? 😊"},"finish_reason":"stop","index":0,"logprobs":null}],"object":"chat.completion","usage":{"prompt_tokens":18,"completion_tokens":39,"total_tokens":57,"prompt_tokens_details":{"cached_tokens":0}},"created":1764672165,"system_fingerprint":null,"model":"qwen-turbo","id":"chatcmpl-e1b33465-ae2e-446c-948e-b9ace66fd6d7","provider":"dashscope"}%                                     
```

# 带model请求

```bash
~/ curl -X POST http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer vk_908782e38b24598fb24da818eea36ef2" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "dash",    
    "model": "qwen-turbo",
    "messages": [
      {"role": "user", "content": "Hello, please respond with TEST_SUCCESS"}
    ],
    "max_tokens": 50
  }'

{"choices":[{"message":{"role":"assistant","content":"TEST_SUCCESS"},"finish_reason":"stop","index":0,"logprobs":null}],"object":"chat.completion","usage":{"prompt_tokens":19,"completion_tokens":2,"total_tokens":21,"prompt_tokens_details":{"cached_tokens":0}},"created":1764677078,"system_fingerprint":null,"model":"qwen-turbo","id":"chatcmpl-6b4a45d2-3e70-4f4a-80ec-57ad90b29b82","provider":"dashscope"}%  
```

# api key(对多provider)

业务: 普通用户不需要限制用户模型, 用哪个都行. 计价就行

租户: 可能会限制只有某些用户可以. 租户可能需要配置条件路由.

## 简要回答

你说得对，确实不需要 "any-model"。在条件路由中，如果不指定具体的 model，系统会自动使用 `default` 指定的目标。

---

## 更简洁的配置方案

### 修正后的配置

```json
{
  "strategy": {
    "mode": "conditional",
    "conditions": [
      {
        "query": { "params.model": "gpt-4" },
        "then": "gpt4-target"
      },
      {
        "query": { "params.model": "claude-3-sonnet" },
        "then": "claude-target"
      }
    ],
    "default": "fallback-target"
  },
  "targets": [
    {
      "name": "fallback-target",
      "strategy": { "mode": "fallback" },
      "targets": [
        { "provider": "openai", "overrideParams": { "model": "gpt-3.5-turbo" } },
        { "provider": "anthropic", "overrideParams": { "model": "claude-3-haiku" } }
      ]
    },
    {
      "name": "gpt4-target",
      "provider": "openai",
      "overrideParams": { "model": "gpt-4" }
    },
    {
      "name": "claude-target",
      "provider": "anthropic",
      "overrideParams": { "model": "claude-3-sonnet" }
    }
  ]
}
```

### 工作流程

1. **指定 gpt-4**：匹配条件，使用 `gpt4-target`
2. **指定 claude-3-sonnet**：匹配条件，使用 `claude-target`
3. **不指定或指定其他模型**：使用 `fallback-target`

### 请求示例

```bash
# 使用默认 fallback
curl -X POST http://localhost:3001/v1/chat/completions \
  -H "x-portkey-config: [上述配置]" \
  -d '{"model": "any-other-model", "messages": [...]}'

# 指定特定模型
curl -X POST http://localhost:3001/v1/chat/completions \
  -H "x-portkey-config: [上述配置]" \
  -d '{"model": "gpt-4", "messages": [...]}'
```

## Notes

- 条件路由通过 `params.model` 检查请求体中的模型参数 [1](#37-0) 
- `overrideParams` 确保使用配置中指定的模型 [2](#37-1) 
- 这种设计更简洁，用户无需了解特殊值，直接按需指定模型即可

Wiki pages you might want to explore:
- [Routing Strategies (Portkey-AI/gateway)](/wiki/Portkey-AI/gateway#2.3)

Wiki pages you might want to explore:
- [Features and Capabilities (Portkey-AI/gateway)](/wiki/Portkey-AI/gateway#1.1)

### Citations

**File:** src/handlers/handlerUtils.ts (L624-626)
```typescript
  currentTarget.overrideParams = {
    ...currentInheritedConfig.overrideParams,
  };
```

**File:** src/handlers/handlerUtils.ts (L731-736)
```typescript
      let params =
        request instanceof FormData ||
        request instanceof ReadableStream ||
        request instanceof ArrayBuffer
          ? {} // Send empty object if not JSON
          : request;
```





## 你的测试结果符合预期

你遇到的情况是 `overrideParams` 的正常工作方式。当配置中指定了 `override_params.model: "qwen-turbo"` 时，无论用户在请求体中发送什么 model，都会被覆盖为 "qwen-turbo"。

---

## 参数覆盖机制

在 `RequestContext` 类中，参数通过以下方式合并 [1](#46-0) ：

```typescript
get params(): Params {
  return this.requestBody instanceof ReadableStream ||
    this.requestBody instanceof FormData ||
    !this.requestBody
    ? {}
    : { ...this.requestBody, ...this.overrideParams };
}
```

### 处理流程

1. **用户请求**：`{"model": "gemini", "messages": [...]}`
2. **配置覆盖**：`overrideParams: {"model": "qwen-turbo"}`
3. **最终参数**：`{"model": "qwen-turbo", "messages": [...]}`

## 如果你想要其他行为

### 1. 允许用户指定模型
从配置中移除 `override_params.model`：

```json
{
  "targets": [
    {
      "provider": "dashscope",
      "override_params": {
        "max_tokens": 2000,
        "temperature": 0.7
        // 移除 model 字段
      }
    }
  ]
}
```

### 2. 限制模型范围
使用 Guardrails 的 `modelWhitelist` [2](#46-1) ：

```json
{
  "before_request_hooks": [
    {
      "id": "model-whitelist",
      "type": "guardrail",
      "deny": true,
      "checks": [{
        "id": "default.modelWhitelist",
        "parameters": {
          "models": ["qwen-turbo", "gemini-pro"],
          "not": false
        }
      }]
    }
  ]
}
```

## Notes

- `overrideParams` 是强制覆盖机制，用于标准化参数 [3](#46-2) 
- SINGLE 策略只固定 provider，不限制 model 选择 [4](#46-3) 
- 如果需要灵活的 model 选择，不要在 `overrideParams` 中指定 model
- 如果需要严格的 model 控制，使用 Guardrails 而非 overrideParams

Wiki pages you might want to explore:
- [Request Transformation System (Portkey-AI/gateway)](/wiki/Portkey-AI/gateway#3.2)

Wiki pages you might want to explore:
- [Routing Strategies (Portkey-AI/gateway)](/wiki/Portkey-AI/gateway#2.3)

### Citations

**File:** src/handlers/services/requestContext.ts (L51-60)
```typescript
  get params(): Params {
    if (this._params !== null) {
      return this._params;
    }
    return this.requestBody instanceof ReadableStream ||
      this.requestBody instanceof FormData ||
      !this.requestBody
      ? {}
      : { ...this.requestBody, ...this.overrideParams };
  }
```

**File:** src/handlers/handlerUtils.ts (L624-626)
```typescript
  currentTarget.overrideParams = {
    ...currentInheritedConfig.overrideParams,
  };
```

**File:** src/handlers/handlerUtils.ts (L765-777)
```typescript
    case StrategyModes.SINGLE:
      const originalIndex = currentTarget.targets[0].originalIndex || 0;
      response = await tryTargetsRecursively(
        c,
        currentTarget.targets[0],
        request,
        requestHeaders,
        fn,
        method,
        `${currentJsonPath}.targets[${originalIndex}]`,
        currentInheritedConfig
      );
      break;
```

## 你的理解需要再次修正

在 Portkey Gateway 中，targets 配置只限制可用的 **provider**，不限制 **model** 的选择。用户可以指定任何 model，只要该 provider 支持即可。

## 你的理解完全正确

通过配置 `targets` 确实可以限制用户只能使用特定的 provider，用户无法通过请求绕过这个限制。

------

## 为什么这种限制有效

### 1. Provider 选择机制

Portkey Gateway 只从请求头中提取 provider 配置，请求体中的 `provider` 字段会被完全忽略 handlerUtils.ts:999-1013 。

### 2. 策略执行逻辑

- **SINGLE 策略**：总是使用 `targets[0]` 的 provider handlerUtils.ts:765-777
- **条件路由**：只能选择 conditions 中定义的 providers
- **FALLBACK/LOADBALANCE**：只能在 targets 数组中选择

### 3. 配置验证

系统验证所有 provider 必须在 `VALID_PROVIDERS` 列表中 config.ts:39-46 。

### 4. 优先级机制

`x-portkey-config` 的优先级高于 `x-portkey-provider` handlerUtils.ts:1005-1011 ，确保配置不会被意外覆盖。

## 实际效果

```
# 用户配置：targets: [{"provider": "dashscope"}]  
# 无论用户请求什么，都只能使用 dashscope  
curl -X POST ... -d '{"provider": "openai", "model": "gpt-4"}'  
# 实际路由到：dashscope
```

## Notes

- 这种限制是 Portkey Gateway 的核心安全特性
- 用户无法通过修改请求体绕过 provider 限制
- 只有修改配置（targets 数组）才能改变可用的 providers
- 这确保了系统的安全性和可控性 index.ts:126-141





## 简要回答

你的API key管理策略非常合理。Portkey Gateway完全支持这种模式：平台统一管理API keys并注入配置，用户通过配置约束来控制可用性。

---

## 实现方案

### 1. 平台级API Key注入

在你的API Gateway中，将采购的API keys注入到用户配置：

```javascript
// API Gateway生成配置时注入API keys
function generateUserConfig(userSubscription) {
  return {
    "strategy": { "mode": "conditional" },
    "targets": userSubscription.providers.map(p => ({
      "name": `${p.provider}-target`,
      "provider": p.provider,
      "api_key": getPlatformApiKey(p.provider), // 平台注入的API key
      "override_params": { "model": p.defaultModel }
    }))
  };
}
```

### 2. 配置传递机制

配置通过`x-portkey-config`头部传递给Portkey Gateway [1](#48-0) ：

```bash
# 用户请求
curl -X POST http://localhost:3001/v1/chat/completions \
  -H "x-portkey-config: [包含平台API keys的配置]" \
  -H "x-portkey-metadata: {\"selected_provider\":\"openai\"}" \
  -d '{"model": "gpt-4", "messages": [...]}'
```

### 3. 用户可用性控制

通过targets数组限制用户可用的providers [2](#48-1) ：

```json
{
  "targets": [
    {"provider": "openai", "api_key": "sk-platform-key-1"},
    {"provider": "anthropic", "api_key": "sk-platform-key-2"}
    // 用户只能选择这些预配置的providers
  ]
}
```

## 架构优势

| 特性            | 平台职责             | Portkey Gateway职责         |
| --------------- | -------------------- | --------------------------- |
| **API Key管理** | 统一采购、存储、注入 | 使用注入的keys调用providers |
| **用户权限**    | 通过targets配置控制  | 验证配置有效性              |
| **成本控制**    | 平台级计费和限额     | 记录使用量供平台统计        |
| **安全性**      | API keys不暴露给用户 | 安全的密钥传递机制          |

## Notes

- 这种模式确保API keys永远不会暴露给最终用户 [3](#48-2) 
- 配置验证确保只有有效的providers能被使用 [4](#48-3) 
- 平台可以动态轮换API keys而无需用户感知
- 支持为不同用户组配置不同的provider访问权限

### 





## 你的理解完全正确

在 Portkey Gateway 中，当配置中不设置 `overrideParams` 时，确实可以实现你描述的效果。

---

## 工作机制

### 1. Model 参数传递
当没有 `overrideParams` 时，`RequestContext` 类会直接使用请求体中的参数 [1](#49-0) ：

```typescript
get params(): Params {
  return { ...this.requestBody, ...this.overrideParams };
}
```

如果 `overrideParams` 为空，则 `params` 就是请求体的原始内容。

### 2. Provider 限制
用户无法绕过配置使用其他 provider，因为：
- Provider 只通过请求头（`x-portkey-config` 或 `x-portkey-provider`）指定 [2](#49-1) 
- 请求体中的 `provider` 字段被完全忽略
- SINGLE 策略总是使用配置的第一个 provider [3](#49-2) 

## 实际效果

```bash
# 用户请求 - 可以指定任何 model
curl -X POST ... -d '{"model": "gpt-4", "messages": [...]}'

# 系统行为
- Provider: 固定为配置中的 openai
- Model: 使用用户指定的 gpt-4
- 结果: 成功（如果 openai 支持 gpt-4）
```

## Notes

- 这种设计让用户在 provider 范围内有 model 选择自由度
- 平台通过 targets 配置控制可用的 providers
- 如果需要限制 model 范围，可以添加 Guardrails [4](#49-3) 



## 通过 Guardrails 中的 `modelWhitelist` 和 `modelRules` 插件精确控制用户能使用的 models

是的，平台可以通过 Guardrails 中的 `modelWhitelist` 和 `modelRules` 插件精确控制用户能使用的 models。 

---

## 详细实现方案

### 1. 使用 modelWhitelist 控制模型范围

```json
{
  "provider": "openai",
  "before_request_hooks": [
    {
      "id": "model-whitelist",
      "type": "guardrail",
      "deny": true,
      "checks": [{
        "id": "default.modelWhitelist",
        "parameters": {
          "models": ["gpt-4", "gpt-3.5-turbo"],
          "not": false
        }
      }]
    }
  ]
}
```

当用户请求不在白名单中的模型时，请求会被拒绝，返回 HTTP 446 错误。 [3](#50-2) 

### 2. 使用 modelRules 实现动态控制

```json
{
  "before_request_hooks": [
    {
      "id": "model-rules",
      "type": "guardrail",
      "deny": true,
      "checks": [{
        "id": "default.modelRules",
        "parameters": {
          "rules": {
            "defaults": ["gpt-3.5-turbo"],
            "metadata": {
              "user_tier": {
                "premium": ["gpt-4", "claude-3-opus"],
                "basic": ["gpt-3.5-turbo"]
              }
            }
          }
        }
      }]
    }
  ]
}
```

modelRules 插件根据请求中的元数据动态确定允许的模型列表 [4](#50-3) 。

### 3. 平台级配置示例

在你的 API Gateway 中，可以根据用户订阅动态生成配置：

```javascript
function generateConfigWithModelControl(userSubscription) {
  return {
    "provider": "openai",
    "before_request_hooks": [{
      "id": "platform-model-control",
      "type": "guardrail",
      "deny": true,
      "checks": [{
        "id": "default.modelWhitelist",
        "parameters": {
          "models": userSubscription.allowedModels,
          "not": false
        }
      }]
    }]
  };
}
```

## Notes

- modelWhitelist 适合静态的白名单控制 [5](#50-4) 
- modelRules 支持基于元数据的动态模型分配 [6](#50-5) 
- 两个插件都在 `beforeRequestHook` 中执行，确保在请求发送前验证 [7](#50-6) 
- 当 `deny: true` 且验证失败时，返回 HTTP 446 状态码





思考:

顶层:

targets: 我们系统维护了价格的provider

models: 平台可以通过 Guardrails 中的 `modelWhitelist` 和 `modelRules` 插件精确控制用户能使用的 models。
