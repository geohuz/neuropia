明白，我帮你整理一个针对 **billing / account_balance / API Gateway** 的 TODO list，标注为 MVP 后续优化项，先保存下来即可。

------

# AI Aggregation 平台 — Billing / Account Balance TODO List

### 1️⃣ 数据层（PostgreSQL）

-  确认 `balance` 与 `overdue_amount` 精度，考虑使用 `numeric(18,6)` 或固定小数位
-  增加 `account_balance` 扣费日志表，用于最终一致性和审计
-  考虑 `user_profile.status` 与 `canceled_at` 对余额使用和扣费的限制

------

### 2️⃣ Redis 缓存 & Lua 脚本

-  实现 Redis crash / 异常恢复策略，保证扣费最终落地 DB
-  优化缓存 TTL 与读写频率，防止高并发导致 PostgREST 压力
-  balanceKey 命名规范化：`balance:user:{id}` / `balance:tenant:{id}`
-  Lua 脚本增加 traceId 或日志，便于问题排查

------

### 3️⃣ BalanceService / BillingService

-  实现异步写回数据库逻辑（消费事件 -> usage_stream -> DB）
-  完善错误处理：区分 tenant/user，增加日志和监控告警
-  扣费策略扩展：结合 PricingCacheManager 支持不同 customer_type / virtual_key 定价
-  考虑处理多线程 / 并发请求时的边缘情况

------

### 4️⃣ API Gateway / proxy.js

-  完善 `checkBudget`，支持复杂预算规则（每日上限、套餐限额）
-  完善 `checkRateLimits`，按 virtual_key、model、tenant 维度限流
-  扣费失败异常处理，保证不会影响监控和响应
-  fallbackConfig 逻辑可扩展，支持多策略降级

------

### 5️⃣ 监控 / 审计 / Usage Stream

-  usage_stream 与 cost_analysis_stream 的完整落地逻辑
-  定期 reconcile Redis 与 PostgreSQL 账户余额
-  监控报表支持 tenant / user 维度的统计

------

### 6️⃣ MVP 后可优化的点

-  定价策略支持动态调整和促销规则
-  异常扣费回滚 / 补偿机制
-  API Gateway 支持预估最大消耗和预算提示
-  异步处理 pipeline 的可靠性（队列/stream 异常处理）

------

# Dec 3

### 简单 ToDo List

**目标**：确保我们明确步骤，避免遗漏。

**任务列表**：

1. **余额变动触发缓存失效**
   - 场景：充值、扣费等任何直接修改账户余额的操作
   - 动作：主动删除或更新 Redis 缓存
2. **TTL 设置**
   - 场景：缓存兜底
   - 动作：保持短 TTL，防止 Redis 长期保存过期数据
3. **价格变化触发缓存失效（后续）**
   - 场景：关联价格变化影响账户余额的计算
   - 动作：批量删除受影响账户的余额缓存
4. **原子扣费/充值**
   - 使用 Lua 脚本保证 Redis 内部数据一致性
5. **日志/监控**
   - 记录缓存失效和余额变动操作，便于排查