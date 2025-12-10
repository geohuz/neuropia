#  api_gateway 控制

# 消费限额

1. 全局个人最小余额告警 (仅对于individual用户(user_profile.tenant_id = null))

2. tenant 消费限额, 对于 user_profile.tenant_id is not null

   a. 软限额: 告警但允许     

   b. 拒绝请求 * TPM/RPM

# 调用限制

| 模型名称 | TPM (token / m) | RPM (requeset /m) |      |      |
| -------- | --------------- | ----------------- | ---- | ---- |

## 最终版 JSON Schema

```sql
'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "API Gateway Control Configuration",
  "description": "API网关控制配置表 - 最终设计：个人用户统一配置，租户可细分配置",
  "type": "object",
  "required": ["target_type", "control_type", "control_value", "is_active"],
  "properties": {
    "id": {"type": "string", "format": "uuid"},
    "target_type": {
      "type": "string", 
      "enum": ["global", "tenant", "customer_type"],
      "description": "global:个人用户全局配置, tenant:租户配置, customer_type:客户类型配置"
    },
    "target_id": {
      "type": ["string", "null"], 
      "format": "uuid",
      "description": "global时为null, tenant时为租户ID, customer_type时为客户类型ID"
    },
    "control_type": {
      "type": "string",
      "enum": ["soft_limit", "hard_limit", "tpm", "rpm"],
      "description": "soft_limit:余额软告警, hard_limit:余额硬拒绝, tpm:token限流, rpm:请求限流"
    },
    "control_value": {
      "type": "number", 
      "minimum": 0,
      "description": "控制值，必须大于等于0"
    },
    "time_window_seconds": {
      "type": ["integer", "null"], 
      "minimum": 1,
      "maximum": 86400,
      "description": "时间窗口秒数"
    },
    "provider_name": {
      "type": ["string", "null"],
      "pattern": "^[a-z][a-z0-9_]*$",
      "maxLength": 50,
      "description": "供应商名称"
    },
    "model_name": {
      "type": ["string", "null"],
      "pattern": "^[a-z][a-z0-9_-]*$", 
      "maxLength": 100,
      "description": "模型名称"
    },
    "is_active": {"type": "boolean", "default": true, "description": "是否启用"},
    "created_at": {"type": "string", "format": "date-time", "description": "创建时间"},
    "updated_at": {"type": "string", "format": "date-time", "description": "更新时间"},
    "created_by": {"type": ["string", "null"], "format": "uuid", "description": "创建人"},
    "updated_by": {"type": ["string", "null"], "format": "uuid", "description": "更新人"}
  },
  "allOf": [
    {
      "title": "全局配置规则",
      "if": {"properties": {"target_type": {"const": "global"}}},
      "then": {
        "properties": {
          "target_id": {"const": null},
          "provider_name": {"const": null},
          "model_name": {"const": null}
        },
        "description": "全局配置（个人用户）不能细分供应商/模型"
      }
    },
    {
      "title": "租户/客户类型必须有关联ID",
      "if": {"properties": {"target_type": {"enum": ["tenant", "customer_type"]}}},
      "then": {
        "required": ["target_id"],
        "description": "租户或客户类型配置必须有对应的ID"
      }
    },
    {
      "title": "个人用户配置不分供应商/模型",
      "if": {"properties": {"target_type": {"enum": ["global", "customer_type"]}}},
      "then": {
        "properties": {
          "provider_name": {"const": null},
          "model_name": {"const": null}
        },
        "description": "个人用户配置（global/customer_type）不能按供应商/模型细分"
      }
    },
    {
      "title": "余额限额无供应商/模型/时间窗口",
      "if": {"properties": {"control_type": {"enum": ["soft_limit", "hard_limit"]}}},
      "then": {
        "properties": {
          "provider_name": {"const": null},
          "model_name": {"const": null},
          "time_window_seconds": {"const": null}
        },
        "description": "余额限额不能有供应商/模型/时间窗口"
      }
    },
    {
      "title": "TPM/RPM必须有时间窗口",
      "if": {"properties": {"control_type": {"enum": ["tpm", "rpm"]}}},
      "then": {
        "required": ["time_window_seconds"],
        "properties": {
          "time_window_seconds": {"type": "integer", "minimum": 1}
        },
        "description": "TPM/RPM必须有时间窗口"
      }
    },
    {
      "title": "RPM无模型规则",
      "if": {"properties": {"control_type": {"const": "rpm"}}},
      "then": {
        "properties": {"model_name": {"const": null}},
        "description": "RPM不能按模型限流"
      }
    },
    {
      "title": "模型名称必须是TPM",
      "if": {"properties": {"model_name": {"type": "string"}}},
      "then": {
        "properties": {"control_type": {"const": "tpm"}},
        "description": "有模型名称必须是TPM"
      }
    },
    {
      "title": "租户可细分供应商/模型",
      "if": {"properties": {"target_type": {"const": "tenant"}}},
      "then": {
        "properties": {
          "control_type": {"enum": ["soft_limit", "hard_limit", "tpm", "rpm"]}
        },
        "description": "租户可以配置所有类型，并可细分供应商/模型"
      }
    }
  ],
  "additionalProperties": false,
  "examples": [
    {
      "title": "个人用户全局TPM",
      "value": {
        "target_type": "global",
        "control_type": "tpm",
        "control_value": 10000,
        "time_window_seconds": 60,
        "is_active": true
      }
    },
    {
      "title": "个人用户全局软限额",
      "value": {
        "target_type": "global",
        "control_type": "soft_limit",
        "control_value": 100,
        "is_active": true
      }
    },
    {
      "title": "租户按供应商TPM",
      "value": {
        "target_type": "tenant",
        "target_id": "550e8400-e29b-41d4-a716-446655440000",
        "control_type": "tpm",
        "control_value": 500000,
        "time_window_seconds": 60,
        "provider_name": "openai",
        "is_active": true
      }
    },
    {
      "title": "客户类型软限额",
      "value": {
        "target_type": "customer_type",
        "target_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        "control_type": "soft_limit",
        "control_value": 500,
        "is_active": true
      }
    }
  ]
}'
```

## 设计描述

### 1. **三层配置体系**
```
global (个人用户全局配置)
  ├── soft_limit: 个人余额软告警
  ├── hard_limit: 个人余额硬拒绝
  ├── tpm: 个人token限流
  └── rpm: 个人请求限流

customer_type (客户类型配置)
  ├── soft_limit: 该类型个人用户余额告警
  ├── hard_limit: 该类型个人用户余额拒绝
  ├── tpm: 该类型个人用户token限流
  └── rpm: 该类型个人用户请求限流

tenant (租户配置)
  ├── soft_limit: 租户余额软告警
  ├── hard_limit: 租户余额硬拒绝
  ├── tpm: 租户token限流（可细分供应商/模型）
  └── rpm: 租户请求限流（可细分供应商）
```

### 2. **核心设计原则**
- **个人用户**：配置简单，不按供应商/模型细分
- **租户**：配置灵活，可按供应商/模型细分
- **余额控制**：只有软/硬限额，没有时间窗口
- **限流控制**：必须有时间窗口，TPM可细分模型，RPM不可

### 3. **配置查找优先级**
```
个人用户 → customer_type配置 → global配置
租户用户 → tenant配置（可细分）→ customer_type配置（不细分）
```

### 4. **运营优势**
- **初期简单**：用global统一配置，快速上线
- **中期灵活**：为租户提供细粒度控制
- **管理高效**：个人用户配置简单，租户配置精细
- **扩展性好**：需要时可为个人用户增加customer_type细分

这个设计平衡了**简单性**和**灵活性**，既满足平台运营效率，又满足客户多样化需求。

## 配置逻辑说明

### 1. **三层配置体系**

```
global (全局)
  ├── balance_alert: 个人用户余额告警阈值
  │
tenant (租户) 
  ├── balance_alert: 租户余额告警阈值
  ├── soft_limit: 租户消费软限额
  ├── hard_limit: 租户消费硬限额  
  ├── tpm: 租户token限流
  └── rpm: 租户请求限流
  │
customer_type (客户类型)
  ├── balance_alert: 客户类型余额告警阈值
  ├── soft_limit: 客户类型消费软限额
  ├── hard_limit: 客户类型消费硬限额
  ├── tpm: 客户类型token限流
  └── rpm: 客户类型请求限流
```

### 2. **Gateway 查找优先级**

```javascript
// 查找配置的优先级（从具体到通用）
function findConfig(user, request) {
  // 1. 租户+供应商+模型 (最具体)
  // 2. 租户+供应商
  // 3. 租户+模型  
  // 4. 租户级别 (最通用)
  // 5. 客户类型+供应商+模型
  // 6. 客户类型+供应商
  // 7. 客户类型+模型
  // 8. 客户类型级别
  // 9. 全局 (仅balance_alert)
}
```

### 3. **余额告警应用场景**

| target_type   | 应用对象       | 检查的余额         |
| ------------- | -------------- | ------------------ |
| global        | 所有个人用户   | 个人用户余额       |
| tenant        | 该租户         | 租户公共余额       |
| customer_type | 该客户类型用户 | 客户类型关联的余额 |

### 4. **TPM/RPM 维度组合**

```
tenant:tpm:openai:gpt-4        # 租户按供应商+模型TPM
tenant:tpm:openai              # 租户按供应商TPM  
tenant:tpm::gpt-4              # 租户按模型TPM（provider_name=null）
tenant:tpm                     # 租户全局TPM

tenant:rpm:openai              # 租户按供应商RPM
tenant:rpm                     # 租户全局RPM
```

### 同一个租户可以有：

1. **全局 TPM** (`provider_name=null, model_name=null`)
2. **按供应商 TPM** (`provider_name='openai', model_name=null`)
3. **按模型 TPM** (`provider_name=null, model_name='gpt-4'`)
4. **按供应商+模型 TPM** (`provider_name='openai', model_name='gpt-4'`)

### 这是因为：

1. **业务需要**：不同供应商/模型可能需要不同的限流策略
2. **成本差异**：GPT-4 比 GPT-3.5 贵，限流应该不同
3. **性能考量**：某些模型响应慢，需要更严格的限流

### 5. **唯一性约束**

- 相同 `(target_type, target_id, control_type, provider_name, model_name)` 只能有一条配置
- 例如：一个租户不能有两条相同的 `tpm:openai:gpt-4` 配置

# 配置示例

| target_type   | target_id  | control_type | provider_id | model_id | value  |
| :------------ | :--------- | :----------- | :---------- | :------- | :----- |
| tenant        | tenant-123 | tpm          | openai      | gpt-4    | 100000 |
| tenant        | tenant-123 | tpm          | anthropic   | claude-3 | 50000  |
| tenant        | tenant-123 | rpm          | NULL        | NULL     | 1000   |
| tenant        | tenant-123 | rpm          | openai      | NULL     | 500    |
| customer_type | vip        | tpm          | openai      | gpt-4    | 200000 |

# 表, trigger

```postgresql
CREATE TABLE IF NOT EXISTS data.gateway_control_config
(
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    target_type text COLLATE pg_catalog."default" NOT NULL,
    target_id uuid,
    control_type text COLLATE pg_catalog."default" NOT NULL,
    control_value numeric NOT NULL,
    currency text COLLATE pg_catalog."default" DEFAULT 'USD'::text,
    time_window_seconds integer,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    created_by uuid,
    updated_by uuid,
    CONSTRAINT gateway_control_config_pkey PRIMARY KEY (id),
    CONSTRAINT unique_control UNIQUE (target_type, target_id, control_type),
    CONSTRAINT gateway_control_config_control_type_check CHECK (control_type = ANY (ARRAY['balance_alert'::text, 'soft_limit'::text, 'hard_limit'::text, 'tpm'::text, 'rpm'::text])),
    CONSTRAINT gateway_control_config_target_type_check CHECK (target_type = ANY (ARRAY['global'::text, 'tenant'::text, 'customer_type'::text])),
    CONSTRAINT valid_window CHECK ((control_type = ANY (ARRAY['tpm'::text, 'rpm'::text])) AND time_window_seconds IS NOT NULL OR (control_type <> ALL (ARRAY['tpm'::text, 'rpm'::text])) AND time_window_seconds IS NULL)
)

```

```postgresql
CREATE OR REPLACE FUNCTION data.notify_gateway_control_change()
    RETURNS trigger
    LANGUAGE 'plpgsql'
    COST 100
    VOLATILE NOT LEAKPROOF
AS $BODY$
DECLARE
    payload_json jsonb := '{}'::jsonb;
    operation_type text;
    target_type_val text;
    target_id_val text;
    control_type_val text;
    value_val numeric;
    time_window_val integer;
BEGIN
    -- 确定操作类型
    operation_type := CASE 
        WHEN TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN 'update'
        WHEN TG_OP = 'DELETE' THEN 'delete'
    END;
    
    -- 获取值
    IF TG_OP = 'DELETE' THEN
        target_type_val := OLD.target_type;
        target_id_val := OLD.target_id::text;
        control_type_val := OLD.control_type;
        value_val := NULL;  -- delete 操作不需要 value
        time_window_val := NULL;
    ELSE
        target_type_val := NEW.target_type;
        target_id_val := NEW.target_id::text;
        control_type_val := NEW.control_type;
        value_val := NEW.control_value;
        time_window_val := NEW.time_window_seconds;
    END IF;
    
    -- 构建基础 payload
    payload_json := jsonb_build_object(
        'operation', operation_type,
        'target_type', target_type_val,
        'control_type', control_type_val
    );
    
    -- 添加 target_id（如果不是全局配置）
    IF target_id_val IS NOT NULL AND target_type_val != 'global' THEN
        payload_json := payload_json || jsonb_build_object('target_id', target_id_val);
    END IF;
    
    -- 添加 value（如果是 update 操作）
    IF operation_type = 'update' AND value_val IS NOT NULL THEN
        payload_json := payload_json || jsonb_build_object('value', value_val);
    END IF;
    
    -- 添加 time_window（如果是 TPM/RPM）
    IF control_type_val IN ('tpm', 'rpm') AND time_window_val IS NOT NULL AND operation_type = 'update' THEN
        payload_json := payload_json || jsonb_build_object('time_window', time_window_val);
    END IF;
    
    -- 发送通知
    PERFORM pg_notify(
        'gateway_control_changes',
        payload_json::text
    );
    
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$BODY$;

```

# 测试

## 全局余额告警

```postgresql
-- 现在测试插入
INSERT INTO data.gateway_control_config (target_type, control_type, control_value) 
VALUES ('global', 'balance_alert', 100);
```

payload:

```json
{
  "value": 100,
  "operation": "update", 
  "target_type": "global",
  "control_type": "balance_alert"
}
```

## 租户软限额

```sql
-- 插入租户配置
INSERT INTO data.gateway_control_config 
(target_type, target_id, control_type, control_value) 
VALUES 
('tenant', '550e8400-e29b-41d4-a716-446655440000', 'soft_limit', 5000);
```

预期 payload：
```json
{
  "value": 5000,
  "operation": "update",
  "target_type": "tenant", 
  "target_id": "550e8400-e29b-41d4-a716-446655440000",
  "control_type": "soft_limit"
}
```

## 租户 TPM 配置

```sql
INSERT INTO data.gateway_control_config 
(target_type, target_id, control_type, control_value, time_window_seconds) 
VALUES 
('tenant', '550e8400-e29b-41d4-a716-446655440000', 'tpm', 1000, 60);
```

预期 payload：
```json
{
  "value": 1000,
  "operation": "update",
  "target_type": "tenant",
  "target_id": "550e8400-e29b-41d4-a716-446655440000", 
  "control_type": "tpm",
  "time_window": 60
}
```

## 删除操作

```sql
DELETE FROM data.gateway_control_config 
WHERE target_type = 'tenant' 
  AND target_id = '550e8400-e29b-41d4-a716-446655440000' 
  AND control_type = 'tpm';
```

预期 payload：
```json
{
  "operation": "delete",
  "target_type": "tenant",
  "target_id": "550e8400-e29b-41d4-a716-446655440000",
  "control_type": "tpm"
}
```

## 更新操作

```postgresql
-- 先插入一条配置，然后更新它
INSERT INTO data.gateway_control_config 
(target_type, target_id, control_type, control_value, time_window_seconds) 
VALUES 
('tenant', '9d865a1b-2c8b-444e-9172-39e2c3517292', 'hard_limit', 20000, NULL);

-- 然后更新这条配置
UPDATE data.gateway_control_config 
SET control_value = 30000, 
    updated_at = now()
WHERE target_type = 'tenant' 
  AND target_id = '9d865a1b-2c8b-444e-9172-39e2c3517292' 
  AND control_type = 'hard_limit';
```

```
{
  "value": 30000,
  "operation": "update",
  "target_type": "tenant",
  "target_id": "9d865a1b-2c8b-444e-9172-39e2c3517292",
  "control_type": "hard_limit"
}
```

# 缓存设计

## 缓存键设计说明：

### 1. **控制配置键**：

- `gateway:control:global:{control_type}` - 全局配置
- `gateway:control:customer_type:{ct_id}:{control_type}` - 客户类型配置
- `gateway:control:tenant:{tenant_id}:{control_type}:{provider}:{model}` - 租户配置（支持多维度）

### 2. **限流计数器键**：

- 自动包含时间窗口，过期自动清理
- 支持个人用户和租户
- 租户支持供应商/模型维度

### 3. **TTL策略**：

- **配置数据**：永不过期（靠notify失效）
- **计数器**：短期自动过期
- **告警标记**：短期避免重复告警
