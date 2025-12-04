const postgrest = require("../clients/postgrest");
const RedisService = require("@shared/clients/redis_op");
const CACHE_KEYS = require("../constants/cacheKeys");
const pgNotifyListener = require("../listeners/pgNotifyListener");
const ALL_CHANNELS = require("../constants/pgNotifyChannels");
const pricingCacheManager = require("./pricingCacheManager"); // 在头部引入

class BalanceService {
  constructor() {
    this.initialized = false;
    this.pricingManager = pricingCacheManager;
  }

  async initialize() {
    if (this.initialized) return;

    pgNotifyListener.eventBus.on(
      ALL_CHANNELS.ACCOUNT_BALANCE_UPDATED,
      async (payload) => {
        await this.handleBalanceChange(payload);
      },
    );

    this.initialized = true;
    console.log("✅ balanceService manager initialized");
  }

  // ------------------------------
  // 处理账户余额变动
  // ------------------------------
  async handleBalanceChange(payload) {
    try {
      // 新格式：{ account_id, account_type, old_balance, new_balance }
      const { account_id, account_type, old_balance, new_balance } = payload;

      console.log(
        `💰 收到余额变动: ${account_type}:${account_id}, ${old_balance} -> ${new_balance}`,
      );

      // 1. 直接更新 Redis 余额缓存
      const balanceKey = CACHE_KEYS.BALANCE(account_type, account_id);
      await RedisService.kv.setex(
        balanceKey,
        CACHE_KEYS.TTL.BALANCE,
        JSON.stringify({
          balance: new_balance,
          updated_at: new Date().toISOString(),
          source: "notify",
        }),
      );

      // 2. 失效相关的 billing_context 缓存
      await this._invalidateRelatedCaches(account_type, account_id);
    } catch (err) {
      console.error("❌ Unexpected error in handleBalanceChange:", err);
    }
  }

  async _invalidateRelatedCaches(accountType, accountId) {
    let query = postgrest.from("virtual_keys").select("virtual_key");

    if (accountType === "user") {
      query = query.eq("user_id", accountId);
    } else {
      query = query.eq("tenant_id", accountId);
    }

    const { data: vks } = await query;

    if (Array.isArray(vks)) {
      for (const { virtual_key } of vks) {
        // 失效 billing_account 缓存
        const billingKey = CACHE_KEYS.BILLING_ACCOUNT(virtual_key);
        await RedisService.kv.del(billingKey);

        // 失效 billing_context 缓存
        const contextKey = CACHE_KEYS.BILLING_CONTEXT(virtual_key);
        await RedisService.kv.del(contextKey);

        console.log(`🧹 失效关联缓存: ${virtual_key}`);
      }
    }
  }

  /**
   * 获取完整的计费上下文
   * @param {string} virtualKey
   * @returns {Promise<BillingContext>}
   */
  async getBillingContext(virtualKey) {
    if (!virtualKey) throw new Error("INVALID_VIRTUAL_KEY");

    const cacheKey = CACHE_KEYS.BILLING_CONTEXT(virtualKey);

    // 1. 检查缓存
    const cached = await RedisService.kv.get(cacheKey);
    if (cached) {
      console.log("📦 BillingContext 缓存命中:", virtualKey);
      return JSON.parse(cached);
    }

    console.log("🔄 BillingContext 缓存未命中，构建:", virtualKey);

    // 2. 构建计费上下文
    const context = await this._buildBillingContext(virtualKey);

    // 3. 写入缓存
    await RedisService.kv.setex(
      cacheKey,
      CACHE_KEYS.TTL.BILLING_CONTEXT,
      JSON.stringify(context),
    );

    console.log("💾 BillingContext 缓存写入:", virtualKey);
    return context;
  }

  /**
   * 内部方法：构建计费上下文
   */
  async _buildBillingContext(virtualKey) {
    // 并行获取账户和价格信息
    const [account, pricing] = await Promise.all([
      this._getAccountInfo(virtualKey), // ✅ 改为私有方法
      this.pricingManager.getVirtualKeyPricing(virtualKey),
    ]);

    // 校验 customer_type_id 一致性
    const accountCtId = account.customer_type_id;
    const pricingCtId = pricing.customer_type_id;
    let consistencyStatus = "valid";

    if (accountCtId !== pricingCtId) {
      console.error(`❌ BillingContext 不一致！virtualKey: ${virtualKey}
               账户 customer_type_id: ${accountCtId}
               价格 customer_type_id: ${pricingCtId}`);

      consistencyStatus = "mismatch";
      // 可以调用修复逻辑
      await this._repairPricingCache(virtualKey, accountCtId);
    }

    // 构建完整上下文
    return {
      virtual_key: virtualKey,
      account: {
        id: account.id,
        type: account.type,
        customer_type_id: accountCtId,
        balance: account.balance, // ✅ 直接使用，不再嵌套
        overdue_amount: account.overdue_amount,
        updated_at: new Date().toISOString(),
      },
      pricing: {
        customer_type_id: pricingCtId,
        prices: pricing.prices,
        cached_at: new Date().toISOString(),
      },
      metadata: {
        cached_at: new Date().toISOString(),
        ttl: CACHE_KEYS.TTL.BILLING_CONTEXT,
        consistency_check: consistencyStatus,
        version: "1.0",
      },
    };
  }

  /**
   * 当发现不一致时，修复价格缓存
   */
  async _repairPricingCache(virtualKey, expectedCustomerTypeId) {
    console.log(
      `🔧 修复价格缓存: ${virtualKey}, 期望 customer_type_id: ${expectedCustomerTypeId}`,
    );

    // 1. 失效现有缓存
    await this.pricingManager.invalidateVirtualKeyPricing(virtualKey);

    // 2. 重新获取（会触发数据库查询）
    const freshPricing =
      await this.pricingManager.getVirtualKeyPricing(virtualKey);

    // 3. 再次校验
    if (freshPricing.customer_type_id !== expectedCustomerTypeId) {
      // 记录严重错误，但不要死循环
      console.error(`❌ 价格修复失败！数据库配置可能错误:
         virtual_key: ${virtualKey}
         期望 customer_type_id: ${expectedCustomerTypeId}
         实际 customer_type_id: ${freshPricing.customer_type_id}`);

      // 仍然返回获取到的价格，让上层处理
      return freshPricing;
    }

    console.log(`✅ 价格缓存修复成功: ${virtualKey}`);
    return freshPricing;
  }

  /**
   * 校验计费上下文的完整性
   */
  async validateBillingContext(context) {
    const issues = [];

    // 1. 检查 customer_type_id 一致性
    if (context.account.customer_type_id !== context.pricing.customer_type_id) {
      issues.push({
        type: "customer_type_mismatch",
        message: `账户和价格的 customer_type_id 不匹配`,
        account_ct_id: context.account.customer_type_id,
        pricing_ct_id: context.pricing.customer_type_id,
      });
    }

    // 2. 检查价格数据完整性
    if (
      !context.pricing.prices ||
      Object.keys(context.pricing.prices).length === 0
    ) {
      issues.push({
        type: "empty_pricing",
        message: "价格配置为空",
      });
    }

    // 3. 检查余额有效性
    if (context.account.balance < 0) {
      issues.push({
        type: "negative_balance",
        message: `余额为负数: ${context.account.balance}`,
      });
    }

    return {
      valid: issues.length === 0,
      issues,
      virtual_key: context.virtual_key,
      checked_at: new Date().toISOString(),
    };
  }

  /**
   * 扣费单个账户
   * @param {{id: string, type: string, account: object}} account
   * @param {number|string} chargeAmount
   */
  async calculateCost(virtualKey, provider, model, usage) {
    // 1. 获取价格信息（通过pricingManager）
    const priceInfo = await this.pricingManager.getProviderModelPrice(
      virtualKey,
      provider,
      model,
    );

    // 2. 计算费用（原PricingManager的逻辑）
    let cost = 0;
    if (priceInfo.pricing_model === "per_token" && priceInfo.price_per_token) {
      const totalTokens =
        (usage.input_tokens || 0) + (usage.output_tokens || 0);
      cost = totalTokens * priceInfo.price_per_token;
    } else if (
      priceInfo.price_per_input_token &&
      priceInfo.price_per_output_token
    ) {
      cost =
        (usage.input_tokens || 0) * priceInfo.price_per_input_token +
        (usage.output_tokens || 0) * priceInfo.price_per_output_token;
    } else if (priceInfo.price_per_token) {
      const totalTokens =
        (usage.input_tokens || 0) + (usage.output_tokens || 0);
      cost = totalTokens * priceInfo.price_per_token;
    } else {
      throw new Error("Invalid pricing model");
    }

    return {
      cost,
      currency: priceInfo.currency || "USD",
      price_info: priceInfo,
      usage,
    };
  }

  async chargeForUsage(virtualKey, provider, model, usage) {
    // 1. 获取完整上下文
    const context = await this.getBillingContext(virtualKey);

    // 1.5 可选：校验上下文
    const validation = await this.validateBillingContext(context);
    if (!validation.valid) {
      console.warn("计费上下文校验警告:", validation.issues);
    }

    // 2. 计算费用
    const { cost } = await this.calculateCost(
      virtualKey,
      provider,
      model,
      usage,
    );

    // 3. 扣费（直接传账户信息）
    const chargeResult = await this.chargeUser(
      context.account.id,
      context.account.type,
      cost,
    );

    return { ...chargeResult, cost, price_info: context.pricing };
  }

  /**
   * 获取账户信息（私有方法，替代原来的 resolveBillingAccount）
   */
  async _getAccountInfo(virtualKey) {
    if (!virtualKey) throw new Error("INVALID_VIRTUAL_KEY");

    const redisKey = CACHE_KEYS.BILLING_ACCOUNT(virtualKey);

    // 1. 检查缓存
    const cached = await RedisService.kv.get(redisKey);
    if (cached) {
      console.log("📦 账户信息缓存命中:", virtualKey);
      return JSON.parse(cached);
    }

    // 2. 查数据库（billing_accounts 视图现在包含 customer_type_id）
    const { data: accountData, error } = await postgrest
      .from("billing_accounts")
      .select("*")
      .eq("virtual_key", virtualKey)
      .single();

    if (error || !accountData) {
      console.error("账户查询失败:", error);
      throw new Error("ACCOUNT_NOT_FOUND");
    }

    // 3. 构建返回格式
    const result = {
      id: accountData.account_id,
      type: accountData.account_type,
      customer_type_id: accountData.customer_type_id, // ✅ 关键字段
      balance: accountData.balance,
      overdue_amount: accountData.overdue_amount,
    };

    // 4. 写缓存
    await RedisService.kv.setex(
      redisKey,
      CACHE_KEYS.TTL.BILLING_ACCOUNT,
      JSON.stringify(result),
    );

    console.log("💾 账户信息缓存写入:", virtualKey);
    return result;
  }

  async chargeUser(accountId, accountType, chargeAmount) {
    // 参数校验
    if (!accountId || !accountType || !chargeAmount) {
      throw new Error("MISSING_PARAMS");
    }

    // 1. 准备扣费参数
    const key = String(CACHE_KEYS.BALANCE(accountType, accountId));
    const chargeStr = String(chargeAmount);

    if (!key) {
      throw new Error("REDIS_KEY_EMPTY");
    }

    if (!chargeStr || isNaN(Number(chargeStr)) || Number(chargeStr) <= 0) {
      throw new Error("INVALID_CHARGE_AMOUNT");
    }

    // 2. 确保余额缓存存在
    await this._ensureBalanceCache(accountId, accountType);

    // 3. Lua 脚本扣费
    const lua = `
       local key = KEYS[1]
       local charge = tonumber(ARGV[1])

       if charge <= 0 then
         return cjson.encode({ err = "INVALID_CHARGE_AMOUNT" })
       end

       local balStr = redis.call("GET", key)

       if not balStr then
         return cjson.encode({ err = "BALANCE_NOT_FOUND" })
       end

       local bal = cjson.decode(balStr)

       if type(bal) ~= "table" or bal.balance == nil then
         return cjson.encode({ err = "INVALID_BALANCE_FORMAT" })
       end

       if bal.balance < charge then
         return cjson.encode({
           err = "INSUFFICIENT_BALANCE",
           current = bal.balance,
           required = charge
         })
       end

       bal.balance = bal.balance - charge
       redis.call("SET", key, cjson.encode(bal))

       return cjson.encode({
         ok = true,
         new_balance = bal.balance,
         charged = charge
       })
     `;

    // 4. 执行脚本
    const client = await RedisService.connect();
    const rawResult = await client.eval(lua, {
      keys: [key],
      arguments: [chargeStr],
    });

    const result = JSON.parse(rawResult);

    if (result.err) {
      throw new Error(result.err);
    }

    console.log(
      `✅ 扣费成功: ${accountType}:${accountId}, 扣费金额: ${chargeAmount}, 新余额: ${result.new_balance}`,
    );

    return result;
  }

  /**
   * 确保余额缓存存在（简化版 ensureCache）
   */
  async _ensureBalanceCache(accountId, accountType) {
    const key = CACHE_KEYS.BALANCE(accountType, accountId);

    const cached = await RedisService.kv.get(key);
    if (cached) return JSON.parse(cached);

    // 缓存不存在，从数据库加载
    const { data, error } = await postgrest
      .from("account_balances")
      .select("*")
      .eq(
        accountType === "tenant" ? "owner_tenantid" : "owner_userid",
        accountId,
      )
      .single();

    if (error || !data) {
      throw new Error("BALANCE_NOT_FOUND");
    }

    const balanceData = {
      balance: data.balance,
      updated_at: new Date().toISOString(),
      source: "database",
    };

    await RedisService.kv.setex(
      key,
      CACHE_KEYS.TTL.BALANCE,
      JSON.stringify(balanceData),
    );
    return balanceData;
  }
}

const balanceService = new BalanceService();
module.exports = balanceService;
