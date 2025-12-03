# portkey gateway 的 x-portkey-config 详解

- 当 `x-portkey-config` 包含 `strategy` 和 `targets` 时，它是一个完整的路由配置 requestBody.ts:175-214
- 如果你想在多个 targets 中动态选择，应该使用 `x-portkey-metadata` 配合条件路由 handlerUtils.ts:723-763
- 请求验证器要求必须提供 `x-portkey-config` 或 `x-portkey-provider` 中的一个 index.ts:106-124

## 主要配置

| 属性                        | 类型          | 描述                   | 约束/默认值                                                 | 示例                                                        |
| --------------------------- | ------------- | ---------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| `strategy.mode`             | string        | 路由策略模式           | 必须是 "loadbalance"、"fallback"、"conditional" 或 "single" | "loadbalance"                                               |
| `targets`                   | array         | 目标提供商配置列表     | 每个元素必须有 `provider`；支持嵌套                         | [{"provider": "openai", "weight": 1}]                       |
| `targets[].provider`        | string        | AI 提供商名称          | 必须在白名单中                                              | "openai"                                                    |
| `targets[].weight`          | number        | 负载均衡权重           | 默认 1；用于随机选择                                        | 0.75                                                        |
| `targets[].override_params` | object        | 覆盖参数（如 api_key） | 可选；用于提供商特定设置                                    | {"api_key": "sk-..."}                                       |
| `retry.attempts`            | number        | 最大重试次数           | 范围 1–5；默认 0（禁用）                                    | 3                                                           |
| `retry.on_status_codes`     | array<number> | 触发重试的状态码       | 默认 [429, 500, 502, 503]                                   | [429, 502]                                                  |
| `request_timeout`           | number        | 请求超时（ms）         | 可选                                                        | 30000                                                       |
| `cache.mode`                | string        | 缓存模式               | "simple"（开源版支持）；"semantic"（企业版）                | "simple"                                                    |
| `before_request_hooks`      | array<object> | 输入验证钩子           | 每个对象指定插件（如 "regexMatch"）                         | [{"plugin": "modelWhitelist", "allowed_models": ["gpt-4"]}] |
| `after_request_hooks`       | array<object> | 输出验证钩子           | 类似 before hooks                                           | [{"plugin": "jsonSchema", "schema": {...}}]                 |
| `metadata`                  | object        | 自定义元数据           | 用于追踪或条件路由                                          | {"user_id": "123"}                                          |

## 补充的配置

| 属性                        | 类型    | 描述                    | 约束/默认值                  | 示例                                                |
| --------------------------- | ------- | ----------------------- | ---------------------------- | --------------------------------------------------- |
| `strategy.on_status_codes`  | array   | 策略级触发状态码        | 可选                         | [429, 500, 502]                                     |
| `strategy.conditions`       | array   | 条件路由规则            | 仅 conditional 模式          | [{"query": {}, "then": "target"}]                   |
| `strategy.default`          | string  | 条件路由默认目标        | 仅 conditional 模式          | "fallback-target"                                   |
| `api_key`                   | string  | API 密钥                | 与 provider 配合使用         | "sk-..."                                            |
| `weight`                    | number  | 根级权重                | 默认 1                       | 0.5                                                 |
| `on_status_codes`           | array   | 根级触发状态码          | 默认 [429, 500, 502, 503]    | [429, 502]                                          |
| `custom_host`               | string  | 自定义 API 主机         | 可选；不能包含 'api.portkey' | "[https://api.custom.com](https://api.custom.com/)" |
| `forward_headers`           | array   | 转发头部列表            | 可选                         | ["x-user-id", "x-org"]                              |
| `strict_open_ai_compliance` | boolean | OpenAI 响应格式严格模式 | 默认 true                    | false                                               |
| `virtual_key`               | string  | 虚拟密钥标识            | 可选                         | "vk_..."                                            |

## 提供商特定字段

| 属性                                                       | 类型   | 描述                  | 适用提供商         |
| ---------------------------------------------------------- | ------ | --------------------- | ------------------ |
| `aws_access_key_id`, `aws_secret_access_key`, `aws_region` | string | AWS 认证信息          | bedrock, sagemaker |
| `vertex_project_id`, `vertex_region`                       | string | Vertex AI 项目和区域  | vertex-ai          |
| `vertex_service_account_json`                              | object | Vertex AI 服务账户    | vertex-ai          |
| `resource_name`, `deployment_id`, `api_version`            | string | Azure OpenAI 资源信息 | azure-openai       |
| `openai_organization`, `openai_project`                    | string | OpenAI 组织和项目     | openai             |
| `anthropic_beta`, `anthropic_version`                      | string | Anthropic 特定参数    | anthropic          |

## api_key 的作用

`api_key` 允许在配置中直接指定提供商的 API 密钥，无需通过 Authorization header 传递 requestBody.ts:50-51 ：

```
{  
  "provider": "openai",  
  "api_key": "sk-..."  
}
```

在配置构造过程中，如果没有提供 Authorization header，系统会使用配置中的 `api_key` 

## overrideParams

`overrideParams` 可以覆盖几乎所有 AI 请求参数，不仅仅是 `model`。

### 可覆盖的参数类型

根据 `Params` 接口定义，`overrideParams` 可以覆盖以下参数：

#### 基础模型参数

- `model` - 模型名称
- `messages` - 对话消息数组
- `prompt` - 提示文本
- `max_tokens` / `max_completion_tokens` - 最大生成令牌数
- `temperature` - 随机性控制 (0-2)
- `top_p` - 核采样参数 (0-1)
- `top_k` - 采样候选数量
- `stream` - 是否流式响应

#### 高级控制参数

- `stop` - 停止词/停止序列
- `presence_penalty` - 存在惩罚 (-2 到 2)
- `frequency_penalty` - 频率惩罚 (-2 到 2)
- `seed` - 随机种子
- `user` - 用户标识
- `n` - 生成候选数量

#### 工具和函数调用

- `tools` - 工具定义数组
- `tool_choice` - 工具选择策略
- `functions` - 函数定义（已弃用）
- `function_call` - 函数调用策略（已弃用）

#### 特殊格式参数

- `response_format` - 响应格式（JSON/文本）
- `logprobs` - 对数概率
- `top_logprobs` - 顶部对数概率
- `echo` - 是否回显输入

#### 提供商特定参数

- `safety_settings` - Google 安全设置
- `anthropic_beta` - Anthropic Beta 功能
- `anthropic_version` - Anthropic 版本
- `thinking` - Anthropic 思考模式
- `dimensions` - 嵌入维度
- `audio` - 音频参数 [1](#8-0) 

### 实际配置示例

#### 1. 基础参数覆盖

```json
{
  "x-portkey-config": {
    "strategy": { "mode": "loadbalance" },
    "targets": [
      {
        "provider": "openai",
        "overrideParams": {
          "model": "gpt-4",
          "temperature": 0.7,
          "max_tokens": 2000,
          "presence_penalty": 0.1,
          "frequency_penalty": 0.1
        },
        "weight": 0.6
      },
      {
        "provider": "anthropic",
        "overrideParams": {
          "model": "claude-3-sonnet",
          "temperature": 0.5,
          "max_tokens": 4000,
          "anthropic_version": "2023-06-01"
        },
        "weight": 0.4
      }
    ]
  }
}
```

#### 2. 工具调用覆盖

```json
{
  "x-portkey-config": {
    "targets": [
      {
        "provider": "openai",
        "overrideParams": {
          "model": "gpt-4",
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "get_weather",
                "description": "Get weather information",
                "parameters": {
                  "type": "object",
                  "properties": {
                    "location": { "type": "string" }
                  }
                }
              }
            }
          ],
          "tool_choice": "auto"
        }
      }
    ]
  }
}
```

#### 3. 响应格式覆盖

```json
{
  "x-portkey-config": {
    "targets": [
      {
        "provider": "openai",
        "overrideParams": {
          "model": "gpt-4",
          "response_format": {
            "type": "json_schema",
            "json_schema": {
              "name": "weather_response",
              "schema": {
                "type": "object",
                "properties": {
                  "temperature": { "type": "number" },
                  "conditions": { "type": "string" }
                }
              }
            }
          }
        }
      }
    ]
  }
}
```

#### 4. 提供商特定参数

```json
{
  "x-portkey-config": {
    "targets": [
      {
        "provider": "google-vertex-ai",
        "overrideParams": {
          "model": "gemini-pro",
          "safety_settings": [
            {
              "category": "HARM_CATEGORY_HARASSMENT",
              "threshold": "BLOCK_MEDIUM_AND_ABOVE"
            }
          ]
        }
      },
      {
        "provider": "anthropic",
        "overrideParams": {
          "model": "claude-3-sonnet",
          "anthropic_beta": ["tools-2024-04-04"],
          "thinking": {
            "type": "enabled",
            "budget_tokens": 5000
          }
        }
      }
    ]
  }
}
```

## targets

以下是 JSON 格式的配置示例：

### 1. loadbalance 模式示例

```json
{  
  "x-portkey-config": {  
    "strategy": {  
      "mode": "loadbalance"  
    },  
    "targets": [  
      {  
        "provider": "openai",  
        "overrideParams": { "model": "gpt-4" },  
        "weight": 60  
      },  
      {  
        "provider": "anthropic",  
        "overrideParams": { "model": "claude-3-sonnet" },  
        "weight": 40  
      }  
    ]  
  }  
}
```

**处理方式**：每10个请求中，大约6个会发给GPT-4，4个发给Claude-3，实现流量分发。

### 2. fallback 模式示例

```json
{
  "x-portkey-config": {
    "strategy": {
      "mode": "fallback"
    },
    "targets": [
      {
        "provider": "openai",
        "overrideParams": {"model": "gpt-4"},
      },
      {
        "provider": "anthropic",
        "overrideParams": {"model": "claude-3-sonnet"},
      },
      {
        "provider": "azure-openai", 
        "overrideParams": {"model": "gpt-35-turbo"}
      }
    ]
  }
}
```

**实际场景**：当OpenAI API出现故障时，系统会自动尝试Anthropic，再不成功则用Azure，确保服务不中断。**依赖数组顺序** - 按 targets 数组中的顺序进行故障转移

### 3. conditional 模式示例（与meta协同）

```json
{
  "x-portkey-config": {
    "strategy": {
      "mode": "conditional"
    },
    "targets": [
      {
        "provider": "openai",
        "overrideParams": {"model": "gpt-4"},
        "meta": {
          "condition": "${request.messages.length < 5}"
        }
      },
      {
        "provider": "anthropic",
        "overrideParams": {"model": "claude-3-sonnet"},
        "meta": {
          "condition": "${request.messages.length >= 5}"
        }
      },
      {
        "provider": "openai", 
        "overrideParams": {"model": "gpt-4-vision"},
        "meta": {
          "condition": "${request.messages[0].containsImage}"
        }
      }
    ]
  }
}
```

**处理机制**：根据消息长度和内容类型智能选择最合适的模型。按数组顺序评估条件，第一个匹配的条件生效.

### 4. single 模式示例

```json
{
  "x-portkey-config": {
    "strategy": {
      "mode": "single"
    },
    "targets": [
      {
        "provider": "openai",
        "overrideParams": {"model": "gpt-3.5-turbo"}
      }
    ]
  }
}
```

**含义**：所有请求都固定发送到GPT-3.5-Turbo，没有备选方案，适合简单应用或测试环境。

**关键点**：

- `targets` 是数组，保持元素顺序
- `fallback` 模式依赖数组顺序决定故障转移优先级
- `loadbalance` 使用 `weight` 字段控制比例
- `conditional` 按数组顺序评估条件
- `single` 使用数组第一个元素

## retry

`retry.on_status_codes` 用于指定在遇到哪些HTTP状态码时进行重试。以下是具体的用法示例：

### 1. 重试服务器错误 (5xx)

```json
{
  "x-portkey-config": {
    "strategy": {
      "mode": "single",
    },
    "targets": [
      {
        "provider": "openai",
        "overrideParams": {"model": "gpt-4"},
      }
    ],
    "retry": {
      "attempts": 3,
      "on_status_codes": [500, 502, 503, 504]
    }
  }
}
```
**场景**：当遇到服务器内部错误、网关错误、服务不可用或网关超时时，自动重试3次。

### 2. 重试限流错误 (429)

```json
{
  "x-portkey-config": {
    "strategy": {
      "mode": "fallback"
    },
    "targets": [
      {
        "provider": "openai",
        "overrideParams": {"model": "gpt-4"},
      },
      {
        "provider": "anthropic",
        "overrideParams": {"model": "claude-3-sonnet"}
      }
    ],
    "retry": {
      "attempts": 2,
      "on_status_codes": [429],
    }
  }
}
```
**场景**：当API返回429（请求过多）时，先重试2次，如果仍然失败则切换到备用提供商。

### 3. 混合错误重试策略

```json
{  
  "x-portkey-config": {  
    "strategy": {    
      "mode": "loadbalance"    
    },    
    "retry": {  
      "attempts": 3,  
      "on_status_codes": [429, 500, 502, 503]  
    },  
    "targets": [    
      {    
        "provider": "openai",    
        "overrideParams": { "model": "gpt-4" },    
        "weight": 40    
      },    
      {    
        "provider": "openai",     
        "overrideParams": { "model": "gpt-3.5-turbo" },    
        "weight": 30    
      },    
      {    
        "provider": "anthropic",    
        "overrideParams": { "model": "claude-3-sonnet" },    
        "weight": 30    
      }    
    ]    
  }  
}

```
**场景**：对限流错误和服务器错误都进行重试.

### 4. 客户端错误选择性重试

```json
{
  "x-portkey-config": {
    "strategy": {
      "mode": "single"
    },
    "targets": [
      {
        "provider": "openai",
        "overrideParams": {"model": "gpt-4"}
      }
    ],
    "retry": {
      "attempts": 1,
      "on_status_codes": [408, 429]
    }
  }
}
```
**场景**：只对请求超时(408)和限流(429)进行重试，其他4xx错误（如400、401）不重试。

### 实际工作流程示例

```json
{
  "x-portkey-config": {
    "retry": {
      "attempts": 3,
      "on_status_codes": [429, 500, 502, 503]
    }
  }
}
```

**执行过程**：
1. 首次请求 → 返回 `429 Too Many Requests`
2. 第1次重试（等待后）→ 返回 `502 Bad Gateway`  
3. 第2次重试（等待后）→ 返回 `200 OK` ✅
4. 重试成功，流程结束

**重要说明**：
- `on_status_codes` 数组明确指定了哪些状态码触发重试机制
- 对于4xx错误，通常只重试`429`（限流）和`408`（超时）
- 对于5xx错误，通常都会重试，因为这是服务器端问题

## strategy.loadbalance 负载均衡的粒度

在 `loadbalance` 模式下，每个 `target` 都是一个独立的负载均衡单元，可以包含：

- 不同的 `provider`
- 不同的 `model`（通过 `overrideParams` 指定）
- 不同的权重 `weight`

### 实际配置示例

#### 不同 Provider + 不同 Model

```json
{
  "strategy": { "mode": "loadbalance" },
  "targets": [
    {
      "provider": "openai",
      "weight": 0.7,
      "overrideParams": { "model": "gpt-4" }
    },
    {
      "provider": "anthropic", 
      "weight": 0.3,
      "overrideParams": { "model": "claude-3-opus-20240229" }
    }
  ]
}
```

#### 同一 Provider + 不同 Model

```json
{
  "strategy": { "mode": "loadbalance" },
  "targets": [
    {
      "provider": "openai",
      "weight": 0.5,
      "overrideParams": { "model": "gpt-4" }
    },
    {
      "provider": "openai",
      "weight": 0.5, 
      "overrideParams": { "model": "gpt-3.5-turbo" }
    }
  ]
}
```

## 配置继承的两个层面

### 1. 优先级层面：子目标覆盖父目标

在执行时，如果子目标定义了某个配置，会优先使用子目标的配置：

```
// 子目标有 retry 时，使用子目标的 retry  
retry: currentTarget.retry  
  ? { ...currentTarget.retry }      // 子目标配置  
  : { ...inheritedConfig.retry },   // 父目标配置
```

handlerUtils.ts:495-500

### 2. 传递方向层面：单向从父到子

配置只能从父目标传递给子目标，子目标的配置变化不会反向影响父目标

### 实际例子

```
{  
  "retry": { "attempts": 5 },        // 父目标配置  
  "targets": [  
    {  
      "retry": { "attempts": 2 },    // 子目标配置（覆盖父级）  
      "provider": "openai"  
    },  
    {  
      "provider": "anthropic"        // 使用父级配置（attempts: 5）  
    }  
  ]  
}
```

### 总结

- **覆盖关系**：子目标配置优先级更高，会"覆盖"父目标的同名配置
- **继承方向**：配置只能从父流向子，是单向的，子不能影响父

这就像 CSS 样式继承：子元素可以覆盖父元素的样式，但子元素的样式变化不会影响父元素。 handlerUtils.ts:488-504

## 配置继承示例

以下是 Portkey Gateway 中配置继承的实际应用示例：

### 1. 重试配置继承

```json
{
  "x-portkey-config": {
    "retry": { "attempts": 5 },           // 父级：默认重试5次
    "strategy": { "mode": "fallback" },
    "targets": [
      {
        "name": "OpenAI 集群",
        "retry": { "attempts": 2 },        // 子级：覆盖为2次
        "targets": [
          { "provider": "openai" },        // 继承：2次重试
          { "provider": "openai" }         // 继承：2次重试
        ]
      },
      {
        "name": "Anthropic 备用",
        "provider": "anthropic"            // 继承：5次重试
      }
    ]
  }
}
```

### 2. 缓存配置继承

```json
{
  "x-portkey-config": {
    "cache": { 
      "mode": "simple", 
      "max_age": 3600 
    },                                   // 父级：缓存1小时
    "strategy": { "mode": "loadbalance" },
    "targets": [
      {
        "provider": "openai",
        "weight": 0.6                     // 继承：缓存1小时
      },
      {
        "provider": "anthropic",
        "cache": { "max_age": 1800 },     // 子级：覆盖为30分钟
        "weight": 0.4
      }
    ]
  }
}
```

### 3. overrideParams 深度合并

```json
{
  "x-portkey-config": {
    "overrideParams": { 
      "temperature": 0.7,
      "max_tokens": 1000
    },                                   // 父级参数
    "strategy": { "mode": "fallback" },
    "targets": [
      {
        "provider": "openai",
        "overrideParams": { 
          "model": "gpt-4",
          "temperature": 0.9             // 子级：覆盖temperature
        }                                 // 合并后：{temperature: 0.9, max_tokens: 1000, model: "gpt-4"}
      },
      {
        "provider": "anthropic",
        "overrideParams": { 
          "model": "claude-3-sonnet"
        }                                 // 合并后：{temperature: 0.7, max_tokens: 1000, model: "claude-3-sonnet"}
      }
    ]
  }
}
```

### 4. 多层嵌套继承

```json
{
  "x-portkey-config": {
    "retry": { "attempts": 3 },
    "cache": { "mode": "simple", "max_age": 7200 },
    "request_timeout": 30000,            // 父级：30秒超时
    "strategy": { "mode": "fallback" },
    "targets": [
      {
        "name": "主要集群",
        "retry": { "attempts": 2 },      // 第一级子目标
        "strategy": { "mode": "loadbalance" },
        "targets": [
          {
            "provider": "openai",
            "weight": 0.7,
            "request_timeout": 15000     // 第二级子目标：覆盖为15秒
          },
          {
            "provider": "openai",
            "weight": 0.3                 // 继承：15秒超时，2次重试
          }
        ]
      },
      {
        "name": "备用集群",
        "provider": "anthropic"           // 继承：30秒超时，3次重试
      }
    ]
  }
}
```

### 5. Hooks 和 Guardrails 继承

```json
{
  "x-portkey-config": {
    "before_request_hooks": [
      { "id": "global-auth", "type": "mutator" }
    ],                                   // 父级：全局前置钩子
    "default_input_guardrails": [
      { "default.contains": {"words": ["spam"], "operator": "none"} }
    ],                                   // 父级：默认输入防护
    "strategy": { "mode": "loadbalance" },
    "targets": [
      {
        "provider": "openai",
        "weight": 0.5                     // 继承所有父级钩子和防护
      },
      {
        "provider": "anthropic",
        "before_request_hooks": [         // 子级：完全替换钩子
          { "id": "anthropic-specific", "type": "mutator" }
        ],
        "input_guardrails": [             // 子级：添加额外防护
          { "default.regexMatch": {"pattern": "\\d{3}-\\d{2}-\\d{4}"} }
        ],
        "weight": 0.5
      }
    ]
  }
}
```

### 6. 特殊字段继承行为

```json
{
  "x-portkey-config": {
    "custom_host": "https://api.primary.com",  // 父级自定义主机
    "forward_headers": ["x-user-id", "x-org"],  // 父级转发头
    "strict_open_ai_compliance": true,          // 父级严格模式
    "strategy": { "mode": "fallback" },
    "targets": [
      {
        "provider": "openai"                     // 继承所有父级配置
      },
      {
        "provider": "anthropic",
        "custom_host": "https://api.backup.com", // 子级：覆盖主机
        "forward_headers": ["x-api-key"],        // 子级：完全替换转发头
        "strict_open_ai_compliance": false        // 子级：关闭严格模式
      }
    ]
  }
}
```

### 继承规则总结

| 字段类型 | 继承行为 | 示例 |
|---------|---------|------|
| **标量字段** (`retry`, `cache`, `timeout`) | 子覆盖父 | 子目标设置 `retry: {attempts: 2}` 覆盖父级的 `retry: {attempts: 5}` |
| **对象字段** (`overrideParams`) | 深度合并 | 父级 `{temperature: 0.7}` + 子级 `{model: "gpt-4"}` = `{temperature: 0.7, model: "gpt-4"}` |
| **数组字段** (`hooks`, `forwardHeaders`) | 完全替换 | 子级设置新数组会完全替换父级数组 |
| **布尔字段** (`strictOpenAiCompliance`) | 子覆盖父 | 子级 `false` 覆盖父级 `true` | [7](#6-6) 

### Notes

- 配置继承是递归的，支持任意深度的嵌套
- 继承在 `tryTargetsRecursively` 函数的每次调用时发生
- 子目标配置优先级始终高于父目标
- 空值或未定义的字段会从父目标继承
- JSON 路径追踪帮助调试复杂的继承关系

# conditional

`strategy: "conditional"` 是 Portkey AI Gateway 中的一个路由策略，它允许您根据请求的元数据、参数或 URL 路径动态选择目标提供商。

## 基本用法

条件路由通过 `ConditionalRouter` 类实现 [1](#0-0) ，在 `tryTargetsRecursively` 函数中被调用 [2](#0-1) 。

### 配置结构

```json
{
  "strategy": {
    "mode": "conditional",
    "conditions": [
      {
        "query": { "条件表达式" },
        "then": "目标名称"
      }
    ],
    "default": "默认目标名称"
  },
  "targets": [
    {
      "name": "目标名称",
      "provider": "openai",
      "api_key": "..."
    }
  ]
}
```

## 支持的操作符

条件路由支持多种比较和逻辑操作符 [3](#0-2) ：

### 比较操作符
- `$eq` - 等于
- `$ne` - 不等于  
- `$gt` - 大于
- `$gte` - 大于等于
- `$lt` - 小于
- `$lte` - 小于等于
- `$in` - 在数组中
- `$nin` - 不在数组中
- `$regex` - 正则匹配

### 逻辑操作符
- `$and` - 逻辑与
- `$or` - 逻辑或

## 条件评估

条件可以基于以下上下文数据 [4](#0-3) ：
- `metadata` - 来自 `x-portkey-metadata` 头部的元数据
- `params` - 请求参数
- `url.pathname` - URL 路径

使用点号访问嵌套属性，如 `metadata.user_tier` [5](#0-4) 。

## 实际示例

```json
{
  "strategy": {
    "mode": "conditional",
    "conditions": [
      {
        "query": { 
          "metadata.user_tier": { "$eq": "premium" }
        },
        "then": "gpt4-target"
      },
      {
        "query": {
          "$or": [
            { "params.model": { "$regex": "gpt-4" } },
            { "metadata.region": { "$in": ["us", "eu"] } }
          ]
        },
        "then": "anthropic-target"
      }
    ],
    "default": "gpt35-target"
  },
  "targets": [
    {
      "name": "gpt4-target",
      "provider": "openai",
      "api_key": "sk-...",
      "override_params": { "model": "gpt-4" }
    },
    {
      "name": "anthropic-target", 
      "provider": "anthropic",
      "api_key": "sk-ant-..."
    },
    {
      "name": "gpt35-target",
      "provider": "openai", 
      "api_key": "sk-...",
      "override_params": { "model": "gpt-3.5-turbo" }
    }
  ]
}
```

## 执行流程

1. 解析 `x-portkey-metadata` 头部获取元数据 [6](#0-5) 
2. 创建 `ConditionalRouter` 实例 [7](#0-6) 
3. 按顺序评估每个条件 [8](#0-7) 
4. 返回第一个匹配条件的目标
5. 如果无匹配且有默认值，返回默认目标 [9](#0-8) 
6. 否则抛出错误 [10](#0-9) 

## Notes

- 条件按顺序评估，第一个匹配的条件生效
- 目标必须通过 `name` 字段在 `targets` 数组中定义
- 条件路由在 schema 验证中受支持 [11](#0-10) 
- 支持嵌套的逻辑操作符组合复杂条件
