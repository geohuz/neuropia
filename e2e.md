完美！🎉 **Gateway配置完全正确！**

## 验证结果：

✅ **配置加载成功**：Gateway从Redis缓存加载了配置  
✅ **三层配置正确**：全局 → 客户类型 → 租户 → 供应商 → 模型  
✅ **查找逻辑正确**：优先级覆盖规则工作正常  
✅ **数值匹配**：所有配置值与预期完全一致

## 现在测试完整的用户请求流程：

### 1. 创建一个测试虚拟密钥和账户余额：

```sql
-- 在数据库中设置测试账户
INSERT INTO billing.accounts 
(account_type, account_id, customer_type_id, balance, currency)
VALUES 
('tenant', '9d865a1b-2c8b-444e-9172-39e2c3517292', 'eb948fd1-b8da-46c7-aa51-92eb296970c8', 1000, 'USD')
ON CONFLICT (account_type, account_id) 
DO UPDATE SET balance = 1000;

-- 创建虚拟密钥映射
INSERT INTO billing.virtual_keys 
(virtual_key, account_type, account_id, customer_type_id, is_active)
VALUES 
('vk_test_gateway', 'tenant', '9d865a1b-2c8b-444e-9172-39e2c3517292', 'eb948fd1-b8da-46c7-aa51-92eb296970c8', true);
```

### 2. 运行API请求测试：

```bash
# 测试请求
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer vk_test_gateway" \
  -d '{
    "model": "gpt-4",
    "provider": "openai",
    "messages": [{"role": "user", "content": "Hello, test gateway control system"}],
    "max_tokens": 50
  }'
```

### 3. 观察日志验证整个流程：

```bash
# 同时监控多个日志源
tail -f logs/combined.log | grep -E "BALANCE_CHECK|RATE_LIMIT|GATEWAY|TPM|RPM|余额|限流"
```

### 4. 测试各种限额场景：

#### 场景A：余额充足，未触发限额
```sql
-- 设置高余额
UPDATE billing.accounts 
SET balance = 10000 
WHERE account_type = 'tenant' 
  AND account_id = '9d865a1b-2c8b-444e-9172-39e2c3517292';
```

#### 场景B：触发软限制（余额500-200之间）
```sql
-- 设置余额在软硬限制之间
UPDATE billing.accounts 
SET balance = 300 
WHERE account_type = 'tenant' 
  AND account_id = '9d865a1b-2c8b-444e-9172-39e2c3517292';
```

#### 场景C：触发硬限制（余额<200）
```sql
-- 设置余额低于硬限制
UPDATE billing.accounts 
SET balance = 100 
WHERE account_type = 'tenant' 
  AND account_id = '9d865a1b-2c8b-444e-9172-39e2c3517292';
```

### 5. 验证TPM/RPM限流：

连续快速发送多个请求，观察是否触发限流：
```bash
# 快速发送5个请求
for i in {1..5}; do
  curl -X POST http://localhost:3000/v1/chat/completions \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer vk_test_gateway" \
    -d '{"model": "gpt-4", "messages": [{"role": "user", "content": "Test $i"}]}' &
done
```

## 预期结果：

1. ✅ **余额检查**：根据余额触发软/硬限制告警/拒绝
2. ✅ **TPM限流**：租户+openai+gpt-4的TPM应为80000 tokens/60s
3. ✅ **RPM限流**：租户+openai的RPM应为1000 requests/60s
4. ✅ **配置优先级**：模型级别配置应覆盖供应商和租户全局

# 租户用户

```
curl -X POST http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer vk_52984a893baa36c94c07b4b121461058" \
  -d '{
    "model": "qwen-turbo",
    "provider": "dashscope",
    "messages": [{"role": "user", "content": "Test"}]
  }'
```

# 普通用户

```
curl -X POST http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer vk_908782e38b24598fb24da818eea36ef2" \
  -d '{
    "model": "qwen-turbo",
    "provider": "dashscope",
    "messages": [{"role": "user", "content": "Test"}]
  }'
```

## 业务层流程

## 注册用户

```
/*
api.register_user(
	p_email text,
	p_username text,
	p_password text,
	p_role text DEFAULT 'norm_user'::text,
	p_tenant_id uuid DEFAULT NULL::uuid)
)

* p_role 可以是norm_user/tenant_admin, default: norm_user
* p_role 如果是tenant_admin必须有tenant_id
* p_role 如果是norm_user, 可选tenant_id(某租户下用户)
* 注册tenant用户必须先插入tenant表, 建立tenant


1. 插入 auth.login（只保存认证信息）
2. 插入 data.user_profile（保存额外信息，包括 tenant_id）
3. 调用 internal.complete_user_registration
    1. 更新 user_profile.status -> pending
    2. 记录状态变更日志: user_status_log -> (null -> pending)
*/

```

```postgresql
INSERT INTO DATA.tenant (NAME, customer_type_id) VALUES ('tesla', 'eb948fd1-b8da-46c7-aa51-92eb296970c8') RETURNING id; -- b3863a67-b9fa-436e-b618-d0c452c9c08c

SELECT api.register_user('tesla_user1@tesla.com', 'tesla_user1', '123', 'norm_user', 'b3863a67-b9fa-436e-b618-d0c452c9c08c'); -- 54020d6c-8741-4d90-b484-1702a6cacf10

SELECT api.create_virtual_key('54020d6c-8741-4d90-b484-1702a6cacf10', 'testp'); 
-- vk_6ccfc552981c961f8a018beba0681c1a

```

