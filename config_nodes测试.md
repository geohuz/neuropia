# 原数据

```
"id"
"80cab1fe-2026-4c63-a4c2-0ad53f29c8c8"
"a68d246e-b5d5-478e-857d-7260c5e7d536"
"45ecde0e-8adf-4022-a0e5-6fab268dbc88"
"834c04a4-96a2-4a97-b270-fcec5cac66ef"
```

# 测试数据设计

```
-- 1. 创建配置节点树（模拟真实的Portkey配置）
INSERT INTO data.config_nodes (name, description, config_data) VALUES
-- 根节点：平台全局默认配置
('platform_root', '平台全局默认配置', '{
  "retry": {"attempts": 3, "backoff_factor": 2},
  "cache": {"mode": "semantic", "max_age": 3600},
  "request_timeout": 30000,
  "strategy": {"mode": "fallback"}
}'),

-- 企业级配置节点
('enterprise_preset', '企业级预设配置', '{
  "retry": {"attempts": 5},
  "request_timeout": 60000,
  "overrideParams": {"temperature": 0.7, "max_tokens": 4000}
}'),

-- 成本优先配置节点  
('cost_optimized_preset', '成本优化配置', '{
  "strategy": {"mode": "loadbalance"},
  "cache": {"max_age": 7200},
  "overrideParams": {"temperature": 0.3}
}'),

-- 低延迟配置节点
('low_latency_preset', '低延迟配置', '{
  "request_timeout": 10000,
  "retry": {"attempts": 2},
  "overrideParams": {"stream": true}
}');

-- 2. 建立继承关系
UPDATE data.config_nodes SET parent_id = 
  (SELECT id FROM data.config_nodes WHERE name = 'platform_root')
WHERE name IN ('enterprise_preset', 'cost_optimized_preset', 'low_latency_preset');

-- 3. 创建用户级配置节点（模拟用户自定义）
INSERT INTO data.config_nodes (name, description, parent_id, config_data) VALUES
('user_custom_1', '用户自定义配置1', 
  (SELECT id FROM data.config_nodes WHERE name = 'enterprise_preset'),
 '{
    "overrideParams": {"model": "gpt-4-turbo", "temperature": 0.9},
    "metadata": {"user_id": "user_123"}
 }'),
('user_custom_2', '用户自定义配置2',
  (SELECT id FROM data.config_nodes WHERE name = 'cost_optimized_preset'),
 '{
    "cache": {"mode": "simple"},
    "overrideParams": {"model": "claude-3-haiku"}
 }');

-- 4. 创建virtual_keys
INSERT INTO data.virtual_key 
  (virtual_key, name, user_id, primary_config_node_id, config_data) 
VALUES
-- 使用企业级配置的virtual_key
('vk_enterprise_1', '企业用户key1', '11111111-1111-1111-1111-111111111111',
  (SELECT id FROM data.config_nodes WHERE name = 'user_custom_1'),
 '{
    "api_key": "sk-enterprise-123",
    "overrideParams": {"top_p": 0.95}
 }'),
 
-- 使用成本优化配置的virtual_key  
('vk_cost_opt_1', '成本优化key1', '22222222-2222-2222-2222-222222222222',
  (SELECT id FROM data.config_nodes WHERE name = 'user_custom_2'),
 '{
    "api_key": "sk-cost-456",
    "headers": {"X-Custom-Header": "value"}
 }'),
 
-- 直接使用预设配置的virtual_key
('vk_low_latency_1', '低延迟key1', '33333333-3333-3333-3333-333333333333',
  (SELECT id FROM data.config_nodes WHERE name = 'low_latency_preset'),
 '{
    "api_key": "sk-latency-789",
    "overrideParams": {"max_tokens": 1000}
 }');
```

