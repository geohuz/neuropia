**不需要！** Gateway层**不需要了解覆盖逻辑**，因为我们已经把覆盖逻辑在PostgreSQL端**预先计算好了**！

## Gateway需要的文档要点：

### 1. **Payload结构（已经确定）**
```json
{
  "global": {},          // 全局配置
  "customer_types": {},  // 客户类型配置  
  "tenants": {}          // 租户配置（可细分供应商/模型）
}
```

### 2. **Gateway查找算法（伪代码）**
```python
def get_config(user, provider=None, model=None):
    """
    user: {
        'tenant_id': 'xxx',      # 可选，租户ID
        'customer_type': 'xxx',  # 可选，客户类型ID
    }
    """
    result = config_payload['global'].copy()
    
    # 1. 客户类型覆盖
    if user.customer_type in config_payload['customer_types']:
        result.update(config_payload['customer_types'][user.customer_type])
    
    # 2. 租户配置覆盖（如果有租户）
    if user.tenant_id in config_payload['tenants']:
        tenant_config = config_payload['tenants'][user.tenant_id]
        
        # 2.1 租户全局
        result.update(tenant_config.get('global', {}))
        
        # 2.2 供应商级别
        if provider and 'providers' in tenant_config:
            if provider in tenant_config['providers']:
                provider_config = tenant_config['providers'][provider]
                result.update(provider_config.get('global', {}))
                
                # 2.3 模型级别
                if model and 'models' in provider_config:
                    if model in provider_config['models']:
                        result.update(provider_config['models'][model])
    
    return result
```

### 3. **缓存键设计**
```
# 通用缓存键格式
config:{tenant_id}:{customer_type}:{provider}:{model}

# 示例：
config::global                    # 无租户用户的全局配置
config::customer_type_abc         # 特定客户类型的配置
config:tenant_xyz::global         # 租户的全局配置
config:tenant_xyz:openai:global   # 租户+供应商配置
config:tenant_xyz:openai:gpt-4    # 租户+供应商+模型配置
```

### 4. **配置项说明**
每个配置项的结构：
```json
{
  "tpm": {
    "value": 10000,      // 限制值
    "time_window": 60    // 时间窗口（秒），null表示无时间窗口
  },
  "rpm": {...},
  "soft_limit": {
    "value": 100,
    "time_window": null  // 余额限制没有时间窗口
  },
  "hard_limit": {...}
}
```

### 5. **Gateway需要做的**：

#### **初始化时**：
1. 从消息队列/HTTP端点获取初始payload
2. 解析并存入内存结构
3. 监听配置更新通知

#### **处理请求时**：
1. 根据用户信息构造查找路径
2. 按优先级合并配置
3. 应用配置（限流、余额检查等）

#### **配置更新时**：
1. 接收新payload
2. 原子性替换内存中的配置
3. （可选）清理相关的速率限制计数器

### 6. **示例场景**：

**用户A**（租户T，使用openai的gpt-4）：
```python
config = get_config(
    user={'tenant_id': 'T', 'customer_type': 'CT'},
    provider='openai', 
    model='gpt-4'
)

# 结果包含（按优先级合并）：
# 1. global配置（基准）
# 2. customer_type CT配置
# 3. 租户T的全局配置
# 4. 租户T+openai的供应商配置
# 5. 租户T+openai+gpt-4的模型配置 ✅ 最具体
```

### 7. **给Gateway开发者的核心提示**：

> **不需要理解覆盖规则！** 你只需要：
> 1. **按优先级顺序查找**（见上面的伪代码）
> 2. **后找到的配置覆盖先找到的**
> 3. **最具体的配置优先级最高**

**这样Gateway的代码会非常简洁，只需要简单的字典查找和合并操作。**

需要我为Gateway写一个完整的示例实现吗？

# gateway 流程

1. **请求到达** → `proxy.js`
2. **余额检查**：
   - 调用`BalanceService.getBillingContext()`获取账户信息
   - 调用`GatewayControlService.checkBalance()`检查是否触发软/硬限制
3. **限流检查**：
   - 调用`GatewayControlService.checkTPM()`检查token限流
   - 调用`GatewayControlService.checkRPM()`检查请求限流
4. **调用AI服务** → Portkey Gateway
5. **扣费**：
   - 调用`BalanceService.chargeForUsage()`进行实际扣费
6. **返回响应**

**分工明确：**

- `BalanceService`: 实际的钱包操作（查余额、扣费、充值）
- `GatewayControlService`: 策略控制（检查限额、限流、告警）