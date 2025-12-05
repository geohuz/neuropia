const postgrest = require("@shared/clients/postgrest");
const RedisService = require("@shared/clients/redis_op");
const CACHE_KEYS = require("../constants/cacheKeys");
const pgNotifyListener = require("../listeners/pgNotifyListener");
const ALL_CHANNELS = require("../constants/pgNotifyChannels");
const pricingCacheManager = require("./pricingCacheManager");
const StreamService = require("@shared/services/streamService");
const logger = require("@shared/utils/logger"); // 导入

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
        // ✅ 通知回调需要catch，避免未处理异常
        try {
          await this.handleBalanceChange(payload);
        } catch (error) {
          logger.error("handleBalanceChange失败", { 
            payload, 
            error: error.message 
          });
        }
      },
    );

    this.initialized = true;
    logger.info("balanceService初始化完成");
  }

  // ------------------------------
  // 处理账户余额变动（异步通知，需要catch）
  // ------------------------------
  async handleBalanceChange(payload) {
    const { account_id, account_type, old_balance, new_balance } = payload;

    logger.info(`余额变动: ${account_type}:${account_id}`, {
      old_balance,
      new_balance,
      delta: new_balance - old_balance
    });

    // 1. 更新Redis缓存
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

    // 2. 失效相关缓存
    await this._invalidateRelatedCaches(account_type, account_id);
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
        await RedisService.kv.del(CACHE_KEYS.BILLING_ACCOUNT(virtual_key));
        await RedisService.kv.del(CACHE_KEYS.BILLING_CONTEXT(virtual_key));
        logger.debug("失效缓存", { virtual_key });
      }
    }
  }

  /**
   * 获取计费上下文
   */
  async getBillingContext(virtualKey) {
    if (!virtualKey) {
      const error = new Error("INVALID_VIRTUAL_KEY");
      error.context = { virtualKey };
      throw error; // ✅ 直接抛出，让调用者处理
    }

    const cacheKey = CACHE_KEYS.BILLING_CONTEXT(virtualKey);

    // 检查缓存
    const cached = await RedisService.kv.get(cacheKey);
    if (cached) {
      logger.debug("缓存命中", { virtualKey });
      return JSON.parse(cached);
    }

    logger.debug("缓存未命中，构建", { virtualKey });

    // 构建上下文（内部错误自然抛出）
    const context = await this._buildBillingContext(virtualKey);

    await RedisService.kv.setex(
      cacheKey,
      CACHE_KEYS.TTL.BILLING_CONTEXT,
      JSON.stringify(context),
    );

    return context;
  }

  /**
   * 内部方法：构建计费上下文
   */
  async _buildBillingContext(virtualKey) {
    // ✅ 不catch，让Promise.all的错误自然抛出
    const [account, pricing] = await Promise.all([
      this._getAccountInfo(virtualKey),
      this.pricingManager.getVirtualKeyPricing(virtualKey),
    ]);

    const accountCtId = account.customer_type_id;
    const pricingCtId = pricing.customer_type_id;

    if (accountCtId !== pricingCtId) {
      logger.error("customer_type_id不匹配", {
        virtualKey,
        account_ct_id: accountCtId,
        pricing_ct_id: pricingCtId
      });
      // ✅ 记录但不抛出，继续执行
    }

    return {
      virtual_key: virtualKey,
      account: {
        id: account.id,
        type: account.type,
        customer_type_id: accountCtId,
        balance: account.balance,
        overdue_amount: account.overdue_amount,
      },
      pricing: {
        customer_type_id: pricingCtId,
        prices: pricing.prices,
      },
      metadata: {
        cached_at: new Date().toISOString(),
        consistency_check: accountCtId === pricingCtId ? "valid" : "mismatch",
      },
    };
  }

  /**
   * 获取账户信息
   */
  async _getAccountInfo(virtualKey) {
    const redisKey = CACHE_KEYS.BILLING_ACCOUNT(virtualKey);

    // 检查缓存
    const cached = await RedisService.kv.get(redisKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // 查询数据库（错误自然抛出）
    const { data: accountData, error } = await postgrest
      .from("billing_accounts")
      .select("*")
      .eq("virtual_key", virtualKey)
      .single();

    if (error) {
      // ✅ 在原始错误上添加上下文，但保留堆栈
      error.message = `账户查询失败 [${virtualKey}]: ${error.message}`;
      throw error;
    }

    if (!accountData) {
      const error = new Error(`账户不存在: ${virtualKey}`);
      error.context = { virtualKey };
      throw error;
    }

    const result = {
      id: accountData.account_id,
      type: accountData.account_type,
      customer_type_id: accountData.customer_type_id,
      balance: accountData.balance,
      overdue_amount: accountData.overdue_amount,
    };

    await RedisService.kv.setex(
      redisKey,
      CACHE_KEYS.TTL.BILLING_ACCOUNT,
      JSON.stringify(result),
    );

    return result;
  }

  /**
   * 计算费用
   */
  async calculateCost(virtualKey, provider, model, usage) {
    // ✅ 不catch，让错误自然抛出
    const priceInfo = await this.pricingManager.getProviderModelPrice(
      virtualKey,
      provider,
      model,
    );

    let cost = 0;
    if (priceInfo.pricing_model === "per_token" && priceInfo.price_per_token) {
      const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
      cost = totalTokens * priceInfo.price_per_token;
    } else if (priceInfo.price_per_input_token && priceInfo.price_per_output_token) {
      cost =
        (usage.input_tokens || 0) * priceInfo.price_per_input_token +
        (usage.output_tokens || 0) * priceInfo.price_per_output_token;
    } else if (priceInfo.price_per_token) {
      const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
      cost = totalTokens * priceInfo.price_per_token;
    } else {
      const error = new Error("无效的价格模型");
      error.context = { virtualKey, provider, model, priceInfo };
      throw error;
    }

    return {
      cost,
      currency: priceInfo.currency || "USD", // ✅ 这里确保有currency
      price_info: priceInfo,
      usage,
    };
  }

  /**
   * 核心扣费方法
   */
  async chargeForUsage(virtualKey, provider, model, usage) {
    // ✅ 这是边界，需要catch
    try {
      logger.info("开始扣费", { virtualKey, provider, model });

      // 1. 获取上下文（错误自然抛出）
      const context = await this.getBillingContext(virtualKey);

      // 2. 计算费用（错误自然抛出）
      const calculation = await this.calculateCost(virtualKey, provider, model, usage);
      
      // 调试用：检查currency
      if (!calculation.currency) {
        logger.warn("currency字段缺失，使用默认值", { virtualKey });
        calculation.currency = "usd";
      }

      const { cost, currency } = calculation;

      // 3. 执行扣费（错误自然抛出）
      const chargeResult = await this.chargeUser(
        context.account.id,
        context.account.type,
        cost,
      );

      // 4. 扣费成功，异步写入Stream
      if (chargeResult.ok) {
        logger.info("扣费成功", { 
          virtualKey, 
          account: `${context.account.type}:${context.account.id}`,
          cost,
          new_balance: chargeResult.new_balance
        });

        // ✅ 异步写入，不阻塞主流程
        this._writeToStreamInBackground({
          account_id: context.account.id,
          account_type: context.account.type,
          virtual_key: virtualKey,
          cost: cost,
          currency: currency,
          provider: provider,
          model: model,
          input_tokens: usage.input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
        }).catch(err => {
          // Stream失败只记录，不影响主流程
          logger.error("Stream写入失败（不影响扣费）", {
            virtualKey,
            error: err.message
          });
        });
      }

      return { ...chargeResult, cost };

    } catch (error) {
      // ✅ 边界处记录完整错误信息
      logger.error("扣费失败", {
        virtualKey,
        provider,
        model,
        error: error.message,
        stack: error.stack, // ✅ 关键：保留堆栈
        context: error.context // ✅ 如果有额外上下文
      });
      
      // 重新抛出，让上层（API层）处理
      throw error;
    }
  }

  /**
   * 异步写入Stream
   */
  async _writeToStreamInBackground(data) {
    // 这里可以加延迟，避免影响主流程
    await StreamService.writeDeduction(data);
  }

  async chargeUser(accountId, accountType, chargeAmount) {
    // 参数校验
    if (!accountId || !accountType || !chargeAmount) {
      const error = new Error("扣费参数缺失");
      error.context = { accountId, accountType, chargeAmount };
      throw error;
    }

    const key = String(CACHE_KEYS.BALANCE(accountType, accountId));
    const chargeStr = String(chargeAmount);

    if (isNaN(Number(chargeStr)) || Number(chargeStr) <= 0) {
      const error = new Error("无效的扣费金额");
      error.context = { chargeAmount, chargeStr };
      throw error;
    }

    await this._ensureBalanceCache(accountId, accountType);

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

    const client = await RedisService.connect();
    const rawResult = await client.eval(lua, {
      keys: [key],
      arguments: [chargeStr],
    });

    const result = JSON.parse(rawResult);

    if (result.err) {
      const error = new Error(result.err);
      error.context = { accountId, accountType, chargeAmount, ...result };
      throw error;
    }

    return result;
  }

  async _ensureBalanceCache(accountId, accountType) {
    const key = CACHE_KEYS.BALANCE(accountType, accountId);

    const cached = await RedisService.kv.get(key);
    if (cached) return JSON.parse(cached);

    const { data, error } = await postgrest
      .from("account_balances")
      .select("*")
      .eq(
        accountType === "tenant" ? "owner_tenantid" : "owner_userid",
        accountId,
      )
      .single();

    if (error) {
      error.message = `余额查询失败 [${accountType}:${accountId}]: ${error.message}`;
      throw error;
    }

    if (!data) {
      const error = new Error(`余额记录不存在: ${accountType}:${accountId}`);
      error.context = { accountId, accountType };
      throw error;
    }

    const balanceData = {
      balance: data.balance,
      updated_at: new Date().toISOString(),
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