```
{  
  "cache": {  
    "mode": "simple"  
  },  
  "retry": {  
    "attempts": 2,  
    "on_status_codes": [429, 502]  
  },  
  "strategy": {  
    "mode": "fallback"  
  },  
  "targets": [  
    {  
      "provider": "dashscope",  
      "override_params": {  
        "model": "qwen-turbo",  
        "max_tokens": 2000,  
        "temperature": 0.7  
      }  
    },  
    {  
      "provider": "openai",  
      "override_params": {  
        "model": "gpt-3.5-turbo",  
        "max_tokens": 2000,  
        "temperature": 0.7  
      }  
    },  
    {  
      "provider": "anthropic",  
      "override_params": {  
        "model": "claude-3-haiku-20240307",  
        "max_tokens": 2000,  
        "temperature": 0.7  
      }  
    }  
  ],  
  "before_request_hooks": [{  
    "id": "model-whitelist",  
    "deny": false,  
    "type": "guardrail",  
    "checks": [{  
      "id": "default.modelWhitelist",  
      "parameters": {  
        "not": false,  
        "models": ["qwen-turbo", "gpt-3.5-turbo", "claude-3-haiku-20240307"]  
      }  
    }]  
  }]  
}

```

## 配置说明

### Fallback 策略工作原理

- 首先尝试 **dashscope** 的 `qwen-turbo` 模型 handlerUtils.ts:661-689
- 如果失败（返回 429 或 502 错误），自动切换到 **openai** 的 `gpt-3.5-turbo`
- 如果 OpenAI 也失败，继续切换到 **anthropic** 的 `claude-3-haiku`

### 关键修正

1. **保留 fallback 策略**：现在有多个 targets，fallback 可以正常工作 requestBody.ts:22-27
2. **修正模型白名单**：
   - `"deny": false` - 改为允许列表模式
   - 包含所有可能使用的模型
3. **移除非标准字段**：删除了 `_neuropia` 元数据 config.ts:11-116

## Notes

- 可以根据需要调整 targets 的顺序来设置优先级
- 每个目标可以使用不同的 `override_params` 来适配特定模型
- retry 配置会在每个 target 上独立生效
- 如果某个 provider 需要特定的认证信息，请添加相应的 `api_key` 或其他认证字段

## strictOpenAiCompliance 参数使用

`strictOpenAiCompliance` 参数控制响应是否只包含 OpenAI 标准格式的字段，过滤掉提供商特有的扩展信息。

### 设置方式

#### 1. 在配置中设置

```json
{
  "provider": "anthropic",
  "strictOpenAiCompliance": true,
  "api_key": "sk-ant-xxx"
}
```

#### 2. 通过 Header 设置

```bash
-H "x-portkey-strict-open-ai-compliance: false"
```

### 工作原理

当 `strictOpenAiCompliance: true` 时：
- 过滤掉 `content_blocks`、`safetyRatings`、`groundingMetadata` 等非标准字段 [1](#36-0) 
- 只返回 OpenAI 标准字段：`id`、`object`、`created`、`model`、`choices`、`usage` [2](#36-1) 

当 `strictOpenAiCompliance: false` 时（默认）：
- 保留所有提供商特有的字段，如 `content_blocks`、`citations` 等 [3](#36-2) 

### 优先级

配置中的设置优先于 header 设置 [4](#36-3) 
- 各个 provider 的响应转换函数都会检查此参数 [5](#36-4) 
- 对于需要提供商特有功能的应用，保持 `false` 以获取更多信息

