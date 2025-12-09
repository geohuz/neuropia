## Portkey Gateway 配置手册

您说得对，Portkey Gateway 的配置确实像一种 DSL。这里为您整理了实用的配置指南。

### 核心概念速查

| 配置项                   | 作用       | 必需字段                     |
| ------------------------ | ---------- | ---------------------------- |
| **provider**             | 单个提供商 | `provider`, `api_key`        |
| **strategy + targets**   | 路由策略   | `strategy.mode`, `targets[]` |
| **cache**                | 缓存配置   | `mode`                       |
| **retry**                | 重试配置   | `attempts`                   |
| **before_request_hooks** | 请求前钩子 | `type`, `checks[]`           |

### 常用配置模式

#### 1. 简单单提供商
```json
{
  "provider": "openai",
  "api_key": "sk-xxx",
  "override_params": {"model": "gpt-3.5-turbo"}
}
``` [1](#33-0) 

#### 2. Fallback 策略
```json
{
  "strategy": {"mode": "fallback"},
  "targets": [
    {"provider": "openai", "api_key": "sk-xxx"},
    {"provider": "anthropic", "api_key": "sk-ant-xxx"}
  ]
}
``` [2](#33-1) 

#### 3. Conditional 路由
```json
{
  "strategy": {
    "mode": "conditional",
    "conditions": [
      {"query": {"params.model": "gpt-4"}, "then": "openai"},
      {"query": {"params.model": "claude-3"}, "then": "anthropic"}
    ],
    "default": "openai"
  },
  "targets": [
    {"name": "openai", "provider": "openai"},
    {"name": "anthropic", "provider": "anthropic"}
  ]
}
``` [3](#33-2) 

#### 4. Model Whitelist
```json
{
  "before_request_hooks": [{
    "id": "model-whitelist",
    "deny": false,
    "type": "guardrail",
    "checks": [{
      "id": "default.modelWhitelist",
      "parameters": {
        "models": ["gpt-4", "gpt-3.5-turbo"]
      }
    }]
  }]
}
``` [4](#33-3) 

### 配置传递方式

| 方式 | 适用场景 | 示例 |
|------|----------|------|
| **x-portkey-config header** | 复杂配置 | `-H "x-portkey-config: '{\"provider\": \"openai\"}'"` |
| **Authorization + x-portkey-provider** | 简单单提供商 | `-H "Authorization: Bearer sk-xxx" -H "x-portkey-provider: openai"` |
| **Virtual Key** | 安全管理 | `{"provider": "openai", "virtualKey": "vk-xxx"}` |

### 实用资源

1. **快速入门**：[cookbook/getting-started](cookbook/README.md) 目录包含基础教程 [5](#33-4) 
2. **配置示例**：控制台页面 [src/public/index.html](src/public/index.html) 有交互式示例 [6](#33-5) 
3. **插件系统**：[plugins/README.md](plugins/README.md) 详细说明 guardrails 用法 [7](#33-6) 
4. **部署指南**：[docs/installation-deployments.md](docs/installation-deployments.md) 各种部署方式 [8](#33-7) 

### 调试技巧

1. **查看错误详情**：错误消息中的 `request_id` 可用于日志追踪
2. **简化配置**：先测试最简单的 `provider` 配置，再逐步添加功能
3. **使用控制台**：访问 `http://localhost:8787/public/` 查看请求日志 [9](#33-8) 

## Notes

- 配置验证失败通常是因为字段结构错误或缺少必需字段 [10](#33-9) 
- 使用 Virtual Key 可以避免在配置中暴露实际 API key [11](#33-10) 
- Model whitelist 在 `beforeRequestHook` 阶段执行，确保安全性 [12](#33-11) 

Wiki pages you might want to explore:
- [Overview (Portkey-AI/gateway)](/wiki/Portkey-AI/gateway#1)

### Citations

**File:** src/public/index.html (L935-943)
```html
      <div class="card routing-config">
        <h2>2. Create a routing config</h2>
        <div class="card-subtitle">Gateway configs allow you to route requests to different providers and models. You can load balance, set fallbacks, and configure automatic retries & timeouts. <a href="#">Learn more</a></div>
        <div class="tabs routing-config-tabs">
          <div class="tab active" data-tab="simple">Simple Config</div>
          <div class="tab" data-tab="loadBalancing">Load Balancing</div>
          <div class="tab" data-tab="fallbacks">Fallbacks</div>
          <div class="tab" data-tab="autoRetries">Retries & Timeouts</div>
        </div>
```

**File:** src/public/index.html (L1148-1153)
```html
      configs["nodejs"]["simple"] = `
      // 1. Create config with provider and API key
      const config = {
        "provider": 'openai',
        "api_key": 'Your OpenAI API key',
      };
```

**File:** src/public/index.html (L1192-1201)
```html
      const fallbackConfig = {
        "strategy": { "mode": "fallback" },
        "targets": [{ // The primary target
          "provider": 'openai',
          "api_key": 'Your OpenAI API key',
        },{ // The fallback target
          "provider": 'anthropic',
          "api_key": 'Your Anthropic API key',
        }],
      };
```

**File:** cookbook/README.md (L22-29)
```markdown
## getting-started
* [Gentle introduction to Portkey Gateway](./getting-started/gentle-introduction-to-portkey-gateway.ipynb)
* [Use Portkey cache to save LLM cost & time](./getting-started/enable-cache.md)
* [Retry automatically on LLM failures](./getting-started/automatic-retries-on-failures.md)
* [Image generation with Gateway](./getting-started/image-generation.ipynb)
* [Writing your first Gateway Config](./getting-started/writing-your-first-gateway-config.md)
* [Automatically Fallback from OpenAI to Azure](./getting-started/fallback-from-openai-to-azure.ipynb)

```

**File:** plugins/README.md (L51-60)
```markdown
### Guardrails

Guardrails in Portkey's AI gateway are a set of checks that are run together within the `beforeRequest` or `afterRequest` hooks to determine a `verdict`. The verdict of a guardrail dictates the actions to be taken on the request or response. For example, if the guardrail fails, the request can be failed, or the response can be returned with a 246 status code indicating that the guardrails failed.

Guardrails can be defined either through the user interface (UI) of Portkey or as a JSON configuration within the Portkey `config`. This flexibility allows for easy management and customization of guardrails according to the specific needs of the application.

### Checks

A check is an individual function that assesses the input prompt or output response against predefined conditions. Each check returns a boolean verdict or may error out if issues are encountered. Checks are the building blocks of guardrails, and Portkey includes a set of predefined checks as well as the ability to add custom checks.

```

**File:** docs/installation-deployments.md (L15-27)
```markdown
## Local Deployment

1. Do [NPM](#node) or [Bun](#bun) Install
2. Run a [Node.js Server](#nodejs-server)
3. Deploy on [App Stack](#deploy-to-app-stack)
4. Deploy on [Cloudflare Workers](#cloudflare-workers)
5. Deploy using [Docker](#docker)
6. Deploy using [Docker Compose](#docker-compose)
7. Deploy on [Replit](#replit)
8. Deploy on [Zeabur](#zeabur)
9. Deploy with [Supabase Functions](#supabase-functions)
10. Deploy using [Fastly](#fastly)

```

**File:** README.md (L117-119)
```markdown
On the Gateway Console (`http://localhost:8787/public/`) you can see all of your local logs in one place.

<img src="https://github.com/user-attachments/assets/362bc916-0fc9-43f1-a39e-4bd71aac4a3a" width="400" />
```