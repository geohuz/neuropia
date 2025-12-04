```
    PERFORM pg_notify(
        'account_balance_updated',
        json_build_object(
            'account_id', p_account_id::text,
            'account_type', p_account_type,
            'old_balance', v_old_balance,
            'new_balance', v_new_balance
        )::text
    );

```

1. **修改 cacheKeys.js**：添加新键
2. **BalanceService 实现 getBillingContext()**：
   - 优先查 `BILLING_CONTEXT` 缓存
   - 未命中时构建并缓存
3. **修改缓存失效逻辑**：余额/价格变化时失效 `BILLING_CONTEXT`
4. **API Gateway 适配**：使用新接口

