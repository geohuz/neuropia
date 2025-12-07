const postgrest = require("@shared/clients/postgrest");
const RedisService = require("@shared/clients/redis_op");
const CACHE_KEYS = require("../constants/cacheKeys");
const pgNotifyListener = require("../listeners/pgNotifyListener");
const ALL_CHANNELS = require("../constants/pgNotifyChannels");
const pricingCacheManager = require("./pricingCacheManager");
const StreamService = require("./streamService");
const logger = require("@shared/utils/logger"); // 导入

class BalanceService {
  /**
   * 获取账户信息
   * @returns {Object} 账户信息
   *   - id: account_balance.id (技术ID，用于外键约束) ✅
   *   - account_owner_id: user_id 或 tenant_id (业务ID)
   *   - type: 'user' 或 'tenant'
   */
  constructor() {
    this.initialized = false;
    this.pricingManager = pricingCacheManager;

    // 批量写参数设置
    this.pendingStreamWrites = [];
    this.isFlushing = false;
    this.flushTimer = null;

    this.batchMode = process.env.STREAM_BATCH_MODE || "on";
    this.batchSize = parseInt(process.env.PRODUCER_BATCH_SIZE) || 20;
    this.flushInterval =
      parseInt(process.env.PRODUCER_FLUSH_INTERVAL_MS) || 1000;
    this.maxQueueSize = parseInt(process.env.PRODUCER_MAX_QUEUE_SIZE) || 1000;
  }

  async initialize() {
    if (this.initialized) return;

    if (this.batchMode === "on") {
      this._startFlushTimer();
      logger.info("启用Stream批量写入", {
        batchSize: this.batchSize,
        flushInterval: this.flushInterval,
      });
    } else {
      logger.info("使用Stream单条写入模式");
    }

    pgNotifyListener.eventBus.on(
      ALL_CHANNELS.ACCOUNT_BALANCE_UPDATED,
      async (payload) => {
        // ✅ 通知回调需要catch，避免未处理异常
        try {
          await this.handleBalanceChange(payload);
        } catch (error) {
          logger.error("handleBalanceChange失败", {
            payload,
            error: error.message,
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
      delta: new_balance - old_balance,
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
        pricing_ct_id: pricingCtId,
      });
      // ✅ 记录但不抛出，继续执行
    }

    return {
      virtual_key: virtualKey,
      account: {
        id: account.id, // 技术ID (account_balance.id)
        account_owner_id: account.account_owner_id,
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
   * 通过 virtual_key 获取扣费账户信息
   *
   * 重要说明：
   * 1. 使用 billing_accounts 视图，该视图通过多表连接提供完整的账户上下文：
   *    virtual_key → user_profile → tenant → account_balance
   *
   * 2. 返回的账户信息包含两个关键ID：
   *    - id: account_balance.id（技术ID，用于数据库外键约束）
   *    - account_owner_id: user_id 或 tenant_id（业务ID，用于Redis缓存和查询）
   *
   * 3. 为什么需要两个ID？
   *    - 数据库表 usage_log.account_id 外键关联 account_balance.id（技术ID）
   *    - 但 Redis 缓存 key 和很多查询逻辑使用 user_id/tenant_id（业务ID）
   *
   * 4. 缓存策略：频繁查询，因为每次扣费都需要此信息
   *
   * @param {string} virtualKey - 虚拟密钥
   * @returns {Object} 包含技术ID和业务ID的账户信息
   * @throws {Error} 如果账户不存在或查询失败
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
      id: accountData.account_balance_id, // ✅ account_balacne.id
      account_owner_id: accountData.account_id, // ✅ user_id or tenant_id
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

      logger.info("chargeForUsage开始", {
        virtualKey,
        context_balance: context.account.balance,
      });

      // 2. 计算费用（错误自然抛出）
      const calculation = await this.calculateCost(
        virtualKey,
        provider,
        model,
        usage,
      );

      // 调试用：检查currency
      if (!calculation.currency) {
        logger.warn("currency字段缺失，使用默认值", { virtualKey });
        calculation.currency = "usd";
      }

      const { cost, currency } = calculation;

      // 3. 执行扣费（错误自然抛出）
      const chargeResult = await this.chargeUser(
        context.account.account_owner_id,
        context.account.type,
        cost,
      );

      // 4. 扣费成功，异步写入Stream
      if (chargeResult.ok) {
        logger.info("扣费成功", {
          virtualKey,
          account: `${context.account.type}:${context.account.id}`,
          cost,
          balance_before: chargeResult.balance_before, // 🆕 添加
          balance_after: chargeResult.new_balance,
        });

        // 先提取 input/output tokens
        const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
        const outputTokens =
          usage.output_tokens || usage.completion_tokens || 0;

        // total_tokens 优先用传进来的，没有就自己算
        const totalTokens = usage.total_tokens || inputTokens + outputTokens;

        // ✅ 异步写入，不阻塞主流程
        this._writeToStreamInBackground({
          account_id: context.account.id,
          account_owner_id: context.account.account_owner_id, // ✅ 业务ID（便于追溯）
          account_type: context.account.type,
          virtual_key: virtualKey,
          cost: cost,
          currency: currency,
          provider: provider,
          model: model,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: totalTokens,
          balance_before: chargeResult.balance_before, // 扣费前的余额
          balance_after: chargeResult.new_balance, // 扣费后的余额
        }).catch((err) => {
          // Stream失败只记录，不影响主流程
          logger.error("Stream写入失败（不影响扣费）", {
            virtualKey,
            error: err.message,
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
        context: error.context, // ✅ 如果有额外上下文
      });

      // 重新抛出，让上层（API层）处理
      throw error;
    }
  }

  /**
   * 异步写入Stream
   */
  async _writeToStreamInBackground(data) {
    try {
      if (this.batchMode === "off") {
        // 单条模式
        await StreamService.writeDeduction(data);
      } else {
        // 检查队列是否已满
        if (this.pendingStreamWrites.length >= this.maxQueueSize) {
          logger.warn("Stream队列已满，丢弃一条记录", {
            currentSize: this.pendingStreamWrites.length,
            maxSize: this.maxQueueSize,
          });
          this.pendingStreamWrites.shift(); // 丢弃最旧的一条
        }

        // 批量模式：加入队列
        this.pendingStreamWrites.push(data);

        // 达到批量大小时立即刷新
        if (this.pendingStreamWrites.length >= this.batchSize) {
          setImmediate(() => this._flushPendingWrites());
        }
      }
    } catch (error) {
      logger.error("Stream写入失败", {
        deduction_id: data.deduction_id || "unknown",
        error: error.message,
        batchMode: this.batchMode,
      });
    }
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

      local balance_before = bal.balance -- 🆕 记录扣费前余额

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
        balance_before = balance_before,  -- 🆕 返回扣费前余额
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

  /**
   * 确保Redis缓存中有余额数据（缓存未命中时的回填机制）
   *
   * 重要说明：
   * 1. 使用 account_balances 视图，该视图是 account_balance 表的简化版，
   *    仅暴露 id、owner_userid、owner_tenantid、balance 等核心字段
   *
   * 2. 此方法仅在缓存未命中时调用：
   *    - chargeUser 的 Lua 脚本返回 "BALANCE_NOT_FOUND" 错误时
   *    - 或其他需要确保余额数据可用的场景
   *
   * 3. 查询逻辑：按业务ID查询（owner_userid 或 owner_tenantid）
   *    注意：不要按 account_balance.id 查询，因为：
   *    - Redis 缓存 key 是基于业务ID构建的
   *    - PostgreSQL 通知使用业务ID
   *    - 保持系统一致性
   *
   * 4. 性能注意：这是保底路径，正常情况应从缓存读取。
   *    如果频繁调用，说明缓存策略有问题。
   *
   * @param {string} accountOwnerId - 业务ID（user_id 或 tenant_id）
   * @param {string} accountType - 账户类型 'user' 或 'tenant'
   * @returns {Object} 余额数据
   * @throws {Error} 如果账户不存在或查询失败
   */
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

  /**
   * 启动定时刷新器
   */
  _startFlushTimer() {
    this.flushTimer = setInterval(async () => {
      await this._flushPendingWrites();
    }, this.flushInterval);
  }

  /**
   * 刷新待写入队列
   */
  async _flushPendingWrites() {
    if (this.isFlushing || this.pendingStreamWrites.length === 0) {
      return;
    }

    this.isFlushing = true;

    try {
      const batch = [...this.pendingStreamWrites];
      this.pendingStreamWrites = [];

      if (batch.length > 0) {
        logger.debug("刷新Stream队列", { batchSize: batch.length });
        await StreamService.writeDeductionsBatch(batch);
      }
    } catch (error) {
      logger.error("批量写入Stream失败", {
        pendingCount: this.pendingStreamWrites.length,
        error: error.message,
        stack: error.stack,
      });
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * 关闭服务时刷新剩余数据
   */
  async shutdown() {
    logger.info("BalanceService正在关闭，刷新剩余Stream数据...");

    // 清理定时器
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.pendingStreamWrites.length > 0) {
      await this._flushPendingWrites();
    }
    logger.info("BalanceService已关闭");
  }
}

const balanceService = new BalanceService();
module.exports = balanceService;
