# 路由策略 - 中文版

## 概述

AI网关通过统一的OpenAI兼容API接口提供对70多个AI提供商的访问，具备高级路由、可靠性和策略执行能力。网关基于Hono框架构建，支持多种部署目标，包括Node.js、Cloudflare Workers和企业云平台。 [1](#0-0) 

## 路由和负载管理

网关通过`tryTargetsRecursively`函数实现了四种不同的路由策略，允许在多个AI提供商和API密钥之间进行复杂的流量管理。

### 路由策略类型

#### 1. FALLBACK（备用策略）

备用路由提供跨多个提供商或API密钥的自动故障转移。每个目标按顺序尝试，直到获得成功响应或所有目标耗尽。

**特性包括：**
- 顺序执行：遍历`targets`数组
- 状态码过滤：通过`strategy.onStatusCodes`配置
- 网关异常处理：当存在`x-portkey-gateway-exception: true`时跳过备用
- 熔断器集成：过滤掉熔断器打开的目标

备用逻辑在尝试下一个目标之前评估三个条件：
1. 如果配置了`onStatusCodes`且响应状态匹配，继续备用
2. 如果未配置`onStatusCodes`且响应不成功，继续备用
3. 如果存在网关异常头，跳过备用并立即返回 [2](#0-1) 

#### 2. LOADBALANCE（负载均衡策略）

负载均衡使用加权随机选择在多个提供商或API密钥之间分配请求。每个目标被分配一个权重（默认为1），选择概率与权重比例成正比。

权重选择算法：
1. 为没有显式权重的提供商分配默认权重1
2. 计算`totalWeight`作为所有提供商权重的总和
3. 生成0到`totalWeight`之间的`randomWeight`
4. 遍历提供商，从`randomWeight`中减去每个权重，直到变为负数
5. 使`randomWeight`变为负数的提供商被选中 [3](#0-2) 

#### 3. CONDITIONAL（条件路由）

条件路由评估请求元数据和参数与配置的条件，动态选择目标提供商。这支持基于用户身份、请求属性或自定义业务逻辑的路由。

条件路由器接收三个输入：
- **metadata**：来自请求头的自定义键值对
- **params**：请求体参数（模型、消息等）
- **url**：用于基于路径的路由的请求URL信息 [4](#0-3) 

#### 4. SINGLE（单一目标策略）

直接路由到指定的单一目标，无需额外的路由逻辑。 [5](#0-4) 

### 配置继承

`tryTargetsRecursively`函数实现了复杂的配置继承，允许嵌套目标从父目标继承设置，同时支持选择性覆盖。

继承的配置字段包括：
- `id`：熔断器标识符
- `overrideParams`：合并，优先使用当前目标
- `retry`：如果未指定，重试设置从父级级联
- `cache`：缓存配置从父级继承
- `requestTimeout`：超时值传播到子级
- `forwardHeaders`：转发到提供商的头部
- `customHost`：自定义基础URL覆盖
- 钩子数组：`beforeRequestHooks`、`afterRequestHooks`等被连接
- 防护栏：从基础级别的简写转换 [6](#0-5) 

## 可靠性功能

### 自动重试

网关实现了复杂的重试逻辑，具有指数退避、提供商特定的重试头部支持和可配置的状态码定位。

**重试配置结构：**
- `attempts`：最大重试次数
- `onStatusCodes`：触发重试的HTTP状态码
- `useRetryAfterHeader`：遵循提供商的重试后头部

**提供商重试头部支持：**
网关遵循来自多种头部格式的提供商指定的重试延迟：
- `retry-after`：以秒为单位的值（转换为毫秒）
- `x-ratelimit-reset-requests`：以毫秒为单位的重置时间
- `x-ratelimit-reset-tokens`：令牌桶重置时间 [7](#0-6) 

### 请求超时

请求超时处理通过中止超过配置持续时间的请求来防止无限挂起。`fetchWithTimeout`函数使用`AbortController`包装fetch调用。

超时响应格式：
```json
{
  "error": {
    "message": "Request exceeded the timeout sent in the request: <timeout>ms",
    "type": "timeout_error",
    "param": null,
    "code": null
  }
}
```

超时配置在多个级别指定：
- 每个目标：目标配置中的`requestTimeout`
- 继承：从父目标传播到子目标
- 优先级：子目标超时覆盖继承值 [8](#0-7) 

### 熔断器集成

网关通过配置继承系统支持熔断器模式集成。当目标具有`id`字段时，表示启用了熔断器跟踪。

熔断器流程：
1. 执行前，过滤`targets`数组以排除`isOpen: true`的条目
2. 映射`originalIndex`以维护报告的位置引用
3. 成功执行后，调用`handleCircuitBreakerResponse`回调
4. 回调接收：响应、熔断器ID、配置、JSON路径和上下文
5. 外部熔断器服务根据响应更新状态 [9](#0-8) 

## Notes

- 路由策略通过`StrategyModes`枚举定义，包括LOADBALANCE、FALLBACK、SINGLE和CONDITIONAL四种模式 [10](#0-9) 
- 所有路由策略都支持配置继承，允许在嵌套目标中复用父级配置
- 熔断器集成需要目标配置中包含`id`字段来启用跟踪
- 重试功能支持提供商特定的重试头部，如OpenAI的`retry-after`头部
- 中文版文档可在`.github/README.cn.md`中找到更多本地化内容 [11](#0-10) 

