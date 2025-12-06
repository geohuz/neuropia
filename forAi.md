业务端对账户充值, 数据库通知(pg notify) 数据结构如下:

    PERFORM pg_notify(
        'account_balance_updated',
        json_build_object(
            'account_id', p_account_id::text,
            'account_type', p_account_type,
            'old_balance', v_old_balance,
            'new_balance', v_new_balance
        )::text
    );

api_gateway 负责接受用户请求服务, 每次请求都会扣取费用, 并实时控制余额避免超额使用. 整个用户消费都是用户请求api_gateway所发生的费用, 为了满足高频请求扣费追踪, 使用redis实时扣费, 余额不足拒绝服务. api_gateway扣费后将信息写入stream,  另外一个独立的服务: billingWorker 负责定期读取stream最后再写回数据库的usage_log. 所以这是个异步扣费并回写数据库的过程. 

下面是相关代码:
const postgrest = require("@shared/clients/postgrest");
const RedisService = require("@shared/clients/redis_op");
const CACHE_KEYS = require("../constants/cacheKeys");
const pgNotifyListener = require("../listeners/pgNotifyListener");
const ALL_CHANNELS = require("../constants/pgNotifyChannels");
const pricingCacheManager = require("./pricingCacheManager");
const StreamService = require("@shared/services/streamService");
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
      account_owner_id: accountData.account_id, // ✅ user_id, tenant_id
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
          new_balance: chargeResult.new_balance,
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
   }

const balanceService = new BalanceService();
module.exports = balanceService;


// services/streamService.js
/*
TODO（需要外部系统）
错误监控和报警
重试队列机制
失败补偿存储
*/
const RedisService = require("@shared/clients/redis_op");

// 配置
const NUM_SHARDS = 16;
const STREAM_PREFIX = "stream:deductions";
const MAX_LEN = 10000;
const BATCH_SIZE = 50; // 批量写入大小

// ----------------------------
// 工具函数
// ----------------------------

function hashAccountId(accountId) {
  let hash = 0;
  for (let i = 0; i < accountId.length; i++) {
    hash = (hash << 5) - hash + accountId.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % NUM_SHARDS;
}

function generateDeductionId() {
  return `ded_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function getShardKey(accountId) {
  const shardIndex = hashAccountId(accountId);
  return `${STREAM_PREFIX}:${shardIndex}`;
}

// 构建Redis XADD命令参数
function buildXAddArgs(streamKey, message) {
  return [
    "XADD",
    streamKey,
    "MAXLEN",
    "~",
    MAX_LEN.toString(),
    "*",
    "deduction_id",
    message.deduction_id,
    "account_id",
    message.account_id,
    "account_type",
    message.account_type,
    "virtual_key",
    message.virtual_key,
    "cost",
    message.cost.toString(),
    "currency",
    message.currency,
    "provider",
    message.provider,
    "model",
    message.model,
    "input_tokens",
    message.input_tokens.toString(),
    "output_tokens",
    message.output_tokens.toString(),
    "total_tokens",
    message.total_tokens.toString(),
    "timestamp",
    message.timestamp,
  ];
}

// ----------------------------
// 核心函数（可独立实现的）
// ----------------------------

/**
 * 单条写入扣费记录
 */
 async function writeDeduction(deductionData) {
    try {
    const deductionId = generateDeductionId();
    const streamKey = getShardKey(deductionData.account_id);

    const message = {
      deduction_id: deductionId,
      account_id: deductionData.account_id,
      account_type: deductionData.account_type,
      virtual_key: deductionData.virtual_key,
      cost: deductionData.cost,
      currency: deductionData.currency || "USD",
      provider: deductionData.provider,
      model: deductionData.model,
      input_tokens: deductionData.input_tokens || 0,
      output_tokens: deductionData.output_tokens || 0,
      total_tokens: deductionData.total_tokens || 0,
      timestamp: deductionData.timestamp || new Date().toISOString(),
    };

    const client = await RedisService.connect();
    const args = buildXAddArgs(streamKey, message);
    await client.sendCommand(args);

    console.log(`✅ Stream写入成功: ${deductionId} -> ${streamKey}`);

    return {
      success: true,
      deduction_id: deductionId,
      stream_key: streamKey,
    };
    } catch (error) {
    console.error("❌ Stream写入失败:", error.message);

    return {
      success: false,
      error: error.message,
      deduction_id: deductionId,
      // TODO: 错误分类和报警（依赖外部系统）
      // TODO: 重试机制（需要重试队列）
    };
    }
 }

/**
 * 批量写入扣费记录（已实现）
 */
  async function writeDeductionsBatch(deductionsArray) {
    if (!deductionsArray || deductionsArray.length === 0) {
    return [];
    }

  const results = [];
  const batchGroups = {};

  // 1. 按分片分组
  for (const deduction of deductionsArray) {
    const shardKey = getShardKey(deduction.account_id);
    if (!batchGroups[shardKey]) {
      batchGroups[shardKey] = [];
    }

    const message = {
      deduction_id: generateDeductionId(),
      account_id: deduction.account_id,
      account_type: deduction.account_type,
      virtual_key: deduction.virtual_key,
      cost: deduction.cost,
      currency: deduction.currency || "USD",
      provider: deduction.provider,
      model: deduction.model,
      input_tokens: deduction.input_tokens || 0,
      output_tokens: deduction.output_tokens || 0,
      total_tokens: deduction.total_tokens || 0,
      timestamp: deduction.timestamp || new Date().toISOString(),
    };
    
    batchGroups[shardKey].push(message);
  }

  // 2. 按分片批量写入
  const client = await RedisService.connect();

  for (const [streamKey, messages] of Object.entries(batchGroups)) {
    // 分批处理，每批 BATCH_SIZE 条
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      const batch = messages.slice(i, i + BATCH_SIZE);

      try {
        // 使用 pipeline 提高性能
        const pipeline = client.multi();
    
        for (const message of batch) {
          const args = buildXAddArgs(streamKey, message);
          pipeline.sendCommand(args);
        }
    
        const pipelineResults = await pipeline.exec();
    
        // 收集结果
        for (let j = 0; j < batch.length; j++) {
          const message = batch[j];
          const result = pipelineResults[j];
    
          results.push({
            success: result !== null,
            deduction_id: message.deduction_id,
            stream_key: streamKey,
            error: result === null ? "Pipeline execution failed" : null,
          });
        }
    
        console.log(
          `✅ Stream批量写入: ${streamKey}, 批次 ${i / BATCH_SIZE + 1}, 数量 ${batch.length}`,
        );
      } catch (error) {
        // 批次失败，记录所有消息为失败
        for (const message of batch) {
          results.push({
            success: false,
            deduction_id: message.deduction_id,
            stream_key: streamKey,
            error: error.message,
          });
        }
    
        console.error(`❌ Stream批量写入失败: ${streamKey}`, error.message);
      }
    }
  }

  return results;
}

/**
 * 清理旧消息（已实现）
 */
  async function cleanupOldMessages(maxAgeHours = 24, maxPerShard = 1000) {
    const client = await RedisService.connect();
    const cleanupStats = {
    total_cleaned: 0,
    shards_cleaned: 0,
    errors: [],
    };

  // 1. 获取24小时前的时间戳
  const cutoffTime = Date.now() - maxAgeHours * 60 * 60 * 1000;
  // Redis Stream ID 格式: <timestamp>-<sequence>
  const cutoffId = `${cutoffTime}-0`;

  // 2. 遍历所有分片
  for (let shardIndex = 0; shardIndex < NUM_SHARDS; shardIndex++) {
    const streamKey = `${STREAM_PREFIX}:${shardIndex}`;

    try {
      // 3. 获取Stream信息
      const infoArgs = ["XINFO", "STREAM", streamKey];
      let streamInfo;
      try {
        streamInfo = await client.sendCommand(infoArgs);
      } catch (err) {
        // Stream不存在，跳过
        continue;
      }
    
      // 4. 获取第一条消息ID
      const firstEntry = await client.sendCommand([
        "XRANGE",
        streamKey,
        "-",
        "+",
        "COUNT",
        "1",
      ]);
      if (!firstEntry || firstEntry.length === 0) {
        continue; // 空Stream
      }
    
      const firstId = firstEntry[0][0]; // [['id', ['field','value']]]
    
      // 5. 如果第一条消息比 cutoffTime 新，说明没有旧消息
      const firstTimestamp = parseInt(firstId.split("-")[0]);
      if (firstTimestamp >= cutoffTime) {
        continue;
      }
    
      // 6. 执行清理（XTRIM）
      const trimArgs = [
        "XTRIM",
        streamKey,
        "MINID",
        "~",
        cutoffId,
        "LIMIT",
        maxPerShard.toString(),
      ];
      const cleaned = await client.sendCommand(trimArgs);
    
      if (cleaned > 0) {
        cleanupStats.total_cleaned += cleaned;
        cleanupStats.shards_cleaned++;
        console.log(`🧹 Stream清理: ${streamKey}, 清理 ${cleaned} 条消息`);
      }
    } catch (error) {
      cleanupStats.errors.push({
        shard: shardIndex,
        error: error.message,
      });
      console.error(`❌ Stream清理失败: ${streamKey}`, error.message);
    }
  }

  return cleanupStats;
}

/**
 * 获取Stream统计信息（已实现）
 */
  async function getStreamStats() {
    const client = await RedisService.connect();
    const stats = {
    total_shards: NUM_SHARDS,
    active_shards: 0,
    total_messages: 0,
    shards: [],
    };

  for (let i = 0; i < NUM_SHARDS; i++) {
    const streamKey = `${STREAM_PREFIX}:${i}`;

    try {
      // 检查Stream是否存在
      const length = await client.sendCommand(["XLEN", streamKey]);
    
      if (length > 0) {
        stats.active_shards++;
        stats.total_messages += length;
    
        // 获取第一条和最后一条消息的时间
        const firstEntry = await client.sendCommand([
          "XRANGE",
          streamKey,
          "-",
          "+",
          "COUNT",
          "1",
        ]);
        const lastEntry = await client.sendCommand([
          "XREVRANGE",
          streamKey,
          "+",
          "-",
          "COUNT",
          "1",
        ]);
    
        let oldestTime = null;
        let newestTime = null;
    
        if (firstEntry && firstEntry.length > 0) {
          const firstId = firstEntry[0][0];
          oldestTime = new Date(parseInt(firstId.split("-")[0]));
        }
    
        if (lastEntry && lastEntry.length > 0) {
          const lastId = lastEntry[0][0];
          newestTime = new Date(parseInt(lastId.split("-")[0]));
        }
    
        stats.shards.push({
          shard: i,
          stream_key: streamKey,
          length: length,
          oldest_message: oldestTime?.toISOString() || null,
          newest_message: newestTime?.toISOString() || null,
        });
      }
    } catch (error) {
      // Stream可能不存在，忽略错误
      console.debug(`Stream ${streamKey} 不存在或访问失败:`, error.message);
    }
  }

  return stats;
}

// ----------------------------
// 预留接口（stub）
// ----------------------------

/**
 * 读取Stream消息（供BillingWorker使用） - 预留
 */
 async function readDeductions(
    shardIndex,
    consumerGroup,
    consumerName,
    count = 100,
 ) {
    // TODO: 实现消费者组读取逻辑
    // 供BillingWorker消费Stream使用
    console.warn("Stream读取功能未实现");
    return [];
 }

/**
 * 确认消息处理完成 - 预留
 */
 async function ackMessage(shardIndex, consumerGroup, messageId) {
    // TODO: 实现消息ACK确认
    console.warn("Stream ACK功能未实现");
    return false;
 }

/**
 * 创建消费者组 - 预留
 */
 async function createConsumerGroup(shardIndex, groupName) {
    // TODO: 创建消费者组
    console.warn("创建消费者组功能未实现");
    return false;
 }

// ----------------------------
// 导出
// ----------------------------
module.exports = {
  // 已实现的
  writeDeduction,
  writeDeductionsBatch,
  cleanupOldMessages,
  getStreamStats,

  // 预留的（stub）
  readDeductions,
  ackMessage,
  createConsumerGroup,

  // 工具函数
  getShardKey,
  generateDeductionId,
};


// neuropia_api_gateway/src/services/schedulerService.js
const StreamService = require("./streamService");
const CONFIG = require("@shared/config").streaming.scheduler;

class SchedulerService {
  // 🔴 集中所有常量在这里
  // static CONFIG = {
  //   // 时间间隔（毫秒）
  //   intervals: {
  //     cleanup: 60 * 60 * 1000, // 1小时清理一次
  //     monitoring: 5 * 60 * 1000, // 5分钟监控一次
  //     initialDelay: 30 * 60 * 1000, // 首次清理延迟30分钟
  //   },

  //   // 清理配置
  //   cleanup: {
  //     maxAgeHours: 24, // 清理24小时前的消息
  //     maxPerShard: 1000, // 每次最多清理1000条/分片
  //   },

  //   // 监控阈值
  //   thresholds: {
  //     backlog: 50000, // 积压超过5万条报警
  //     shardImbalance: 10, // 分片不均衡超过10倍
  //   },

  //   // 报警配置
  //   alerts: {
  //     enabled: false, // TODO: 启用报警
  //     levels: ["warning", "critical"],
  //   },
  // };

  constructor() {
    this.intervals = new Map();
    this.isRunning = false;
    this.config = CONFIG;
  }

  /**
   * 启动所有定时任务
      */
    startAll() {

    if (this.isRunning) {
      console.warn("定时任务已在运行中");
      return;
    }
    
    console.log("🚀 启动定时任务...");
    
    // 1. Stream清理任务
    this._startStreamCleanup();
    
    // 2. Stream监控任务
    this._startStreamMonitoring();
    
    this.isRunning = true;
    console.log("✅ 定时任务启动完成");
  }

  /**
   * 停止所有定时任务
      */
    stopAll() {

    console.log("🛑 停止定时任务...");
    
    for (const [name, intervalId] of this.intervals.entries()) {
      clearInterval(intervalId);
      console.log(`已停止: ${name}`);
    }
    
    this.intervals.clear();
    this.isRunning = false;
    console.log("✅ 定时任务已停止");
  }

  /**
   * 启动Stream清理任务
      */
    _startStreamCleanup() {

    const TASK_NAME = "stream_cleanup";
    const config = this.config;
    
    // 延迟执行第一次清理
    setTimeout(() => {
      this._executeStreamCleanup();
    }, config.intervals.initialDelay);
    
    // 设置定时器
    const intervalId = setInterval(() => {
      this._executeStreamCleanup();
    }, config.intervals.cleanup);
    
    this.intervals.set(TASK_NAME, intervalId);
    console.log(`${TASK_NAME} 已启动，首次延迟30分钟，之后间隔1小时`);
  }

  /**
   * 执行Stream清理
      */
    async _executeStreamCleanup() {

    const startTime = Date.now();
    const config = this.config;
    
    try {
      console.log("🧹 开始清理Stream旧消息...");
    
      const result = await StreamService.cleanupOldMessages(
        config.cleanup.maxAgeHours,
        config.cleanup.maxPerShard,
      );
    
      const duration = Date.now() - startTime;
    
      if (result.total_cleaned > 0) {
        console.log(
          `Stream清理完成，清理 ${result.total_cleaned} 条消息，耗时 ${duration}ms`,
        );
      } else {
        console.log(`Stream无旧消息可清理，耗时 ${duration}ms`);
      }
    } catch (error) {
      console.error("❌ Stream清理失败:", error);
    }
  }

  /**
   * 启动Stream监控任务
      */
    _startStreamMonitoring() {

    const TASK_NAME = "stream_monitoring";
    const config = this.config;
    
    // 立即执行一次监控
    this._executeStreamMonitoring();
    
    // 设置定时器
    const intervalId = setInterval(() => {
      this._executeStreamMonitoring();
    }, config.intervals.monitoring);
    
    this.intervals.set(TASK_NAME, intervalId);
    console.log(`⏰ ${TASK_NAME} 已启动，间隔5分钟`);
  }

  /**
   * 执行Stream监控
      */
    async _executeStreamMonitoring() {

    const startTime = Date.now();
    const config = this.config;
    
    try {
      console.log("📊 检查Stream状态...");
    
      const stats = await StreamService.getStreamStats();
      const duration = Date.now() - startTime;
    
      // 基础日志
      console.log(
        `📊 Stream状态: 历史消息=${stats.total_messages}, 待处理=${stats.pending_messages || 0}, 延迟=${stats.consumer_lag || 0}ms, ${stats.active_shards}/${stats.total_shards}活跃分片, 耗时 ${duration}ms`,
      );
    
      // 检查异常情况
      const alerts = this._checkStreamAlerts(stats);
    
      if (alerts.length > 0) {
        alerts.forEach((alert) => {
          console.warn(`⚠️ ${alert.level.toUpperCase()}: ${alert.message}`);
        });
      }
    } catch (error) {
      console.error("❌ Stream监控失败:", error);
    }
  }

  /**
   * 检查Stream异常并生成报警
      */
    _checkStreamAlerts(stats) {

    const alerts = [];
    const config = this.config;
    
    // 1. 消息积压过多
    if ((stats.pending_message || 0) > config.thresholds.backlog) {
      alerts.push({
        level: "warning",
        type: "stream_backlog",
        message: `Stream消息积压过多: ${stats.total_messages} 条`,
        threshold: config.thresholds.backlog,
        actual: stats.total_messages,
      });
    }
    
    // 2. 分片消息分布不均
    const maxShardMessages = Math.max(
      ...stats.shards.map((s) => s.length || 0),
    );
    const minShardMessages = Math.min(
      ...stats.shards.map((s) => s.length || 0),
    );
    
    if (maxShardMessages > 0 && minShardMessages > 0) {
      const ratio = maxShardMessages / minShardMessages;
      if (ratio > config.thresholds.shardImbalance) {
        alerts.push({
          level: "warning",
          type: "shard_imbalance",
          message: `Stream分片负载不均衡，最大/最小分片消息比: ${ratio.toFixed(2)}`,
          max_shard: maxShardMessages,
          min_shard: minShardMessages,
          ratio: ratio,
        });
      }
    }
    
    return alerts;
  }

  /**
   * 获取当前运行状态
      */
    getStatus() {

    return {
      is_running: this.isRunning,
      active_tasks: Array.from(this.intervals.keys()),
      task_count: this.intervals.size,
      config: this.config, // 返回配置供调试
    };
  }
}

// 创建单例
const schedulerService = new SchedulerService();

// 优雅关闭处理
process.on("SIGTERM", () => {
  console.log("收到 SIGTERM 信号，停止定时任务...");
  schedulerService.stopAll();
});

process.on("SIGINT", () => {
  console.log("收到 SIGINT 信号，停止定时任务...");
  schedulerService.stopAll();
});

module.exports = schedulerService;


// neuropia_billing_worker/src/streamConsumer.js
const RedisService = require("@shared/clients/redis_op");
const dbWriter = require("./dbWriter");
const sharedConfig = require("@shared/config");
const CONFIG = sharedConfig.streaming.consumer;

const config = {
  ...CONFIG,
  consumerName: `worker_${process.pid}_${Date.now()}`,
};
// 配置
// const CONFIG = {
//   // Stream配置
//   streamPrefix: "stream:deductions",
//   numShards: 16,
//   consumerGroup: "billing_workers",
//   consumerName: `worker_${process.pid}_${Date.now()}`,

//   // 消费策略
//   batchSize: 50, // 每批处理50条
//   pollInterval: 100, // 轮询间隔100ms
//   blockTime: 5000, // 阻塞读取超时5秒

//   // 重试策略
//   maxRetries: 3, // 最大重试次数
//   retryDelay: 1000, // 重试延迟1秒（指数退避）

//   // 监控（预留stub）
//   enableMetrics: false, // TODO: 监控指标
//   enableDeadLetter: false, // TODO: 死信队列
// };

// 🎯 添加全局控制标志
let shouldStopConsuming = false;
let isConsuming = false;

/**
 * 启动Stream消费者
 */
  async function startStreamConsumer(userConfig = {}) {
    const config = {
    ...CONFIG,
    ...userConfig,
    // 🎯 总是动态生成
    consumerName: `worker_${process.pid}_${Date.now()}`,
    };

  // 重置停止标志
  shouldStopConsuming = false;
  isConsuming = true;

  console.log("🚀 启动Stream消费者:", {
    consumerGroup: config.consumerGroup,
    consumerName: config.consumerName,
    numShards: config.numShards,
    batchSize: config.batchSize,
  });

  try {
    // 1. 测试数据库连接
    const dbTest = await dbWriter.testConnection();
    if (!dbTest.ok) {
      throw new Error(`数据库连接失败: ${dbTest.error}`);
    }

    // 2. 初始化消费者组（所有分片）
    await initConsumerGroups(config);
    
    // 3. 启动消费循环
    await consumeLoop(config);
  } catch (error) {
    console.error("❌ Stream消费者启动失败:", error);
    isConsuming = false;
    throw error;
  } finally {
    isConsuming = false;
  }
}

/**
 * 初始化消费者组（所有分片）
 */
  async function initConsumerGroups(config) {
    const client = await RedisService.connect();

  for (let shardIndex = 0; shardIndex < config.numShards; shardIndex++) {
    const streamKey = `${config.streamPrefix}:${shardIndex}`;

    try {
      // 尝试创建消费者组
      await client.sendCommand([
        "XGROUP",
        "CREATE",
        streamKey,
        config.consumerGroup,
        "0", // 从ID 0开始消费
        "MKSTREAM", // 如果Stream不存在就创建
      ]);
    
      console.log(`✅ 初始化消费者组: ${streamKey} -> ${config.consumerGroup}`);
    } catch (error) {
      // 消费者组可能已存在（BUSYGROUP错误）
      if (!error.message.includes("BUSYGROUP")) {
        console.error(`❌ 初始化消费者组失败 ${streamKey}:`, error.message);
        // TODO: 记录到监控
      }
    }
  }
}

/**
 * 主消费循环
 */
  async function consumeLoop(config) {
    console.log("🔄 进入消费循环...");

  let loopCounter = 0;

  while (!shouldStopConsuming) {
    loopCounter++;
    let messages = [];
    let shardIndex = null;

    try {
      // 🎯 定期记录心跳（每100次循环）
      if (loopCounter % 100 === 0) {
        console.log(`❤️  消费循环心跳: ${loopCounter}次`);
      }
    
      // 1. 读取消息（轮询所有分片）
      const readResult = await readMessagesFromStreams(config);
      messages = readResult.messages;
      shardIndex = readResult.shardIndex;
    
      // 🎯 检查是否应该停止
      if (shouldStopConsuming) {
        console.log("🛑 收到停止信号，退出消费循环");
        break;
      }
    
      if (messages.length === 0) {
        // 没有消息，短暂休眠
        await sleep(config.pollInterval);
        continue;
      }
    
      console.log(`📨 从分片 ${shardIndex} 读取到 ${messages.length} 条消息`);
    
      // TODO: 监控 - 记录消息读取速率
      // metrics.increment('stream.messages.read', messages.length);
    
      // 2. 处理消息（写入数据库）
      const processResult = await processMessageBatch(messages, config);
    
      // 3. 发送ACK确认
      if (processResult.success && shardIndex !== null) {
        await acknowledgeMessages(
          shardIndex,
          processResult.processedIds,
          config,
        );
      }
    
      // 4. 处理失败的消息（如果有）
      if (processResult.failedMessages.length > 0) {
        await handleFailedMessages(processResult.failedMessages, config);
      }
    
      // TODO: 监控 - 记录处理延迟
      // metrics.timing('stream.processing.latency', processResult.duration);
    } catch (error) {
      // 🎯 在这里处理错误，而不是让它们变成未捕获异常
      console.error("❌ 消费循环内部错误:", {
        message: error.message,
        stack: error.stack,
        loopCount: loopCounter,
      });
    
      // 🎯 检查是否应该停止
      if (shouldStopConsuming) {
        console.log("🛑 收到停止信号，退出消费循环");
        break;
      }
    
      console.error("❌ 消费循环错误:", error);
    
      // TODO: 错误分类处理
      // if (isTransientError(error)) {
      //   await sleep(config.retryDelay);
      //   continue;
      // } else {
      //   // 严重错误，可能需要重启
      //   throw error;
      // }
    
      // 暂时简单处理：休眠后继续
      await sleep(config.retryDelay);
    }
  }

  console.log("✅ 消费循环已停止");
}

/**
 * 从所有分片读取消息（轮询）
 */
  async function readMessagesFromStreams(config) {
    const client = await RedisService.connect();

  // 轮询所有分片，直到找到有消息的分片
  for (let shardIndex = 0; shardIndex < config.numShards; shardIndex++) {
    // 🎯 检查是否应该停止
    if (shouldStopConsuming) {
      return { messages: [], shardIndex: null };
    }

    const streamKey = `${config.streamPrefix}:${shardIndex}`;
    
    try {
      // 使用消费者组读取
      const result = await client.sendCommand([
        "XREADGROUP",
        "GROUP",
        config.consumerGroup,
        config.consumerName,
        "COUNT",
        config.batchSize.toString(),
        "BLOCK",
        config.blockTime.toString(),
        "STREAMS",
        streamKey,
        ">", // '>' 表示只读取未处理的消息
      ]);
    
      if (result) {
        // 解析消息
        const messages = parseStreamMessages(result, shardIndex);
        if (messages.length > 0) {
          return { messages, shardIndex };
        }
      }
    } catch (error) {
      // 🎯 检查是否应该停止
      if (shouldStopConsuming) {
        return { messages: [], shardIndex: null };
      }
    
      // 🎯 处理NOGROUP错误：如果stream不存在，尝试创建
      if (
        error.message.includes("NOGROUP") ||
        error.message.includes("no such key")
      ) {
        console.warn(`⚠️ Stream不存在，尝试创建: ${streamKey}`);
        try {
          await client.sendCommand([
            "XGROUP",
            "CREATE",
            streamKey,
            config.consumerGroup,
            "0",
            "MKSTREAM",
          ]);
          console.log(`✅ 重新创建Stream: ${streamKey}`);
        } catch (createError) {
          if (!createError.message.includes("BUSYGROUP")) {
            console.error(`❌ 创建Stream失败: ${createError.message}`);
          }
        }
      } else {
        console.error(`❌ 读取分片 ${shardIndex} 失败:`, error.message);
      }
      // 继续尝试下一个分片
    }
  }

  return { messages: [], shardIndex: null };
}

/**
 * 解析Stream消息
 */
  function parseStreamMessages(redisResult, shardIndex) {
    if (!redisResult || !Array.isArray(redisResult) || redisResult.length === 0) {
    return [];
    }

  const messages = [];

  try {
    // Redis返回格式: [[streamKey, [[messageId, [field1, value1, field2, value2, ...]]]]]
    const streamData = redisResult[0]; // 第一个Stream
    const messageList = streamData[1]; // 消息列表

    for (const [messageId, fieldValues] of messageList) {
      // 将字段值对转换为对象
      const message = { messageId, shardIndex };
    
      for (let i = 0; i < fieldValues.length; i += 2) {
        const field = fieldValues[i];
        const value = fieldValues[i + 1];
        message[field] = value;
      }
    
      // 尝试解析JSON字段
      if (message.metadata) {
        try {
          message.metadata = JSON.parse(message.metadata);
        } catch (e) {
          // 保持原样
        }
      }
    
      messages.push(message);
    }
  } catch (error) {
    console.error("❌ 解析Stream消息失败:", error);
    // TODO: 记录到监控
  }

  return messages;
}

/**
 * 处理一批消息
 */
  async function processMessageBatch(messages, config) {
    const startTime = Date.now();
    const processedIds = [];
    const failedMessages = [];

  try {
    // 1. 转换为dbWriter需要的格式
    const dbMessages = messages.map((msg) => ({
      deduction_id: msg.deduction_id,
      virtual_key: msg.virtual_key,
      account_id: msg.account_id,
      account_type: msg.account_type,
      provider: msg.provider,
      model: msg.model,
      cost: parseFloat(msg.cost),
      currency: msg.currency || "USD",
      input_tokens: parseInt(msg.input_tokens) || 0,
      output_tokens: parseInt(msg.output_tokens) || 0,
      total_tokens: parseInt(msg.total_tokens) || 0,
      timestamp: msg.timestamp,
      metadata: msg.metadata || {},
    }));

    // 2. 调用dbWriter写入数据库
    const writeResult = await dbWriter.writeDeductionBatch(dbMessages, {
      batchSize: config.batchSize,
      skipInvalid: true,
    });
    
    // 3. 收集处理成功的消息ID
    for (const msg of messages) {
      // TODO: 需要更精确的成功判断
      // 目前假设只要在valid_messages中就成功
      processedIds.push(msg.messageId);
    }
    
    // 4. 收集失败的消息（如果有）
    if (writeResult.errors && writeResult.errors.length > 0) {
      writeResult.errors.forEach((error) => {
        const failedMsg = messages.find(
          (msg) => msg.deduction_id === error.deduction_id,
        );
        if (failedMsg) {
          failedMessages.push({
            message: failedMsg,
            error: error.message,
          });
        }
      });
    }
    
    console.log(
      `✅ 处理完成: ${writeResult.written_usage_log} usage + ${writeResult.written_audit_log} audit, 失败: ${failedMessages.length}`,
    );
    
    return {
      success: true,
      processedIds,
      failedMessages,
      duration: Date.now() - startTime,
      writeResult,
    };
  } catch (error) {
    console.error("❌ 处理消息批次失败:", error);

    // TODO: 错误分类
    // 临时错误：网络、DB暂时不可用
    // 永久错误：数据格式问题
    
    return {
      success: false,
      processedIds: [],
      failedMessages: messages.map((msg) => ({
        message: msg,
        error: error.message,
      })),
      duration: Date.now() - startTime,
      error: error.message,
    };
  }
}

/**
 * 发送ACK确认消息
 */
  async function acknowledgeMessages(shardIndex, messageIds, config) {
    if (messageIds.length === 0) {
    return;
    }

  const streamKey = `${config.streamPrefix}:${shardIndex}`;
  const client = await RedisService.connect();

  try {
    // 批量发送ACK
    for (const messageId of messageIds) {
      // 🎯 检查是否应该停止
      if (shouldStopConsuming) {
        console.log("🛑 停止过程中，跳过剩余ACK");
        break;
      }
      await client.sendCommand([
        "XACK",
        streamKey,
        config.consumerGroup,
        messageId,
      ]);
    }

    console.log(`✅ 发送ACK: 分片 ${shardIndex}, ${messageIds.length} 条消息`);
    
    // TODO: 监控 - ACK成功率
    // metrics.increment('stream.ack.success', messageIds.length);
  } catch (error) {
    console.error(`❌ 发送ACK失败 ${streamKey}:`, error);

    // TODO: 监控 - ACK失败
    // metrics.increment('stream.ack.failure');
    
    // TODO: ACK失败处理策略
    // 1. 重试ACK
    // 2. 记录到监控
    // 3. 可能需要人工干预
  }
}

/**
 * 处理失败的消息
 */
  async function handleFailedMessages(failedMessages, config) {
    if (failedMessages.length === 0) {
    return;
    }

  console.warn(`⚠️ 有 ${failedMessages.length} 条消息处理失败`);

  // TODO: 实现失败处理策略
  // 1. 临时错误：加入重试队列
  // 2. 永久错误：记录到死信队列
  // 3. 发送报警

  // 暂时简单记录日志
  failedMessages.forEach(({ message, error }, index) => {
    console.error(`失败消息 ${index + 1}:`, {
      deduction_id: message.deduction_id,
      account_id: message.account_id,
      cost: message.cost,
      error: error,
      raw_message: message,
    });
  });
}

/**
 * 休眠函数
 */
 function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
 }

/**
 * 停止消费者
 */
  async function stopConsumer() {
    console.log("🛑 停止Stream消费者...");

  if (!isConsuming) {
    console.log("ℹ️ Stream消费者未运行");
    return;
  }

  // 1. 设置停止标志
  shouldStopConsuming = true;

  // 2. 等待消费循环停止（最多10秒）
  const maxWaitTime = 10000;
  const startWait = Date.now();

  while (isConsuming && Date.now() - startWait < maxWaitTime) {
    console.log("⏳ 等待消费循环停止...");
    await sleep(500);
  }

  if (isConsuming) {
    console.warn("⚠️ 消费循环未在10秒内停止，可能卡住了");
  } else {
    console.log("✅ Stream消费者已停止");
  }

  return true;
}

module.exports = {
  startStreamConsumer,
  stopConsumer,
  // 导出配置供测试
  CONFIG,
};


// neuropia_billing_worker/src/dbWriter.js
const pool = require("@shared/clients/pg");

/**
 * 批量写入扣费记录到数据库（只写入usage_log和audit表）
 * @param {Array} messages - Stream消息数组
 * @param {Object} options - 配置选项
 * @returns {Promise<Object>} 写入结果
 */
  async function writeDeductionBatch(messages, options = {}) {
    const startTime = Date.now();
    const batchId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  console.log(`🔄 开始处理批次 ${batchId}, 消息数: ${messages.length}`);

  // 默认配置
  const config = {
    batchSize: 100,
    skipInvalid: true,
    maxRetries: 3,
    ...options,
  };

  const result = {
    batch_id: batchId,
    total_messages: messages.length,
    valid_messages: 0,
    invalid_messages: 0,
    written_usage_log: 0,
    written_audit_log: 0,
    errors: [],
    start_time: new Date(startTime).toISOString(),
    end_time: null,
    duration_ms: 0,
  };

  let client = null;

  try {
    // 1. 验证和过滤消息
    const { validMessages, invalidMessages } =
      validateAndFilterMessages(messages);
    result.valid_messages = validMessages.length;
    result.invalid_messages = invalidMessages.length;

    // 记录无效消息
    invalidMessages.forEach((msg) => {
      result.errors.push({
        type: "invalid_data",
        deduction_id: msg.deduction_id,
        message: "数据格式无效",
        data: msg,
      });
    });
    
    if (validMessages.length === 0) {
      console.warn(`⚠️ 批次 ${batchId} 无有效消息`);
      return result;
    }
    
    // 2. 获取数据库连接
    client = await pool.connect();
    
    // 3. 开始事务
    await client.query("BEGIN");
    
    // 4. 按账户分组
    const groupedByAccount = groupMessagesByAccount(validMessages);
    
    // 5. 批量写入 usage_log
    const usageLogResult = await insertUsageLogs(client, groupedByAccount);
    result.written_usage_log = usageLogResult.inserted;
    
    if (usageLogResult.idMap && Object.keys(usageLogResult.idMap).length > 0) {
      // 6. 批量写入 account_balance_audit
      const auditLogResult = await insertAuditLogs(
        client,
        groupedByAccount,
        usageLogResult.idMap,
      );
      result.written_audit_log = auditLogResult.inserted;
    }
    
    // 7. 提交事务（不写daily_summary！）
    await client.query("COMMIT");
    
    console.log(`✅ 批次 ${batchId} 处理完成:
      有效消息: ${result.valid_messages}
      usage_log: ${result.written_usage_log}
      audit_log: ${result.written_audit_log}`);
  } catch (error) {
    // 8. 事务失败，回滚
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("回滚失败:", rollbackError);
      }
    }

    result.errors.push({
      type: "transaction_failed",
      message: error.message,
      stack: error.stack,
    });
    
    console.error(`❌ 批次 ${batchId} 事务失败:`, error.message);
  } finally {
    // 9. 释放连接
    if (client) {
      client.release();
    }

    // 10. 计算耗时
    result.end_time = new Date().toISOString();
    result.duration_ms = Date.now() - startTime;
  }

  return result;
}

/**
 * 验证和过滤消息
 */
  function validateAndFilterMessages(messages) {
    const validMessages = [];
    const invalidMessages = [];

  for (const msg of messages) {
    try {
      // 必填字段检查
      const requiredFields = [
        "deduction_id",
        "account_id",
        "account_type",
        "virtual_key",
        "cost",
        "provider",
        "model",
      ];
      const missingFields = requiredFields.filter((field) => !msg[field]);

      if (missingFields.length > 0) {
        throw new Error(`缺少必填字段: ${missingFields.join(", ")}`);
      }
    
      // 数据类型检查
      if (typeof msg.cost !== "number" || msg.cost <= 0) {
        throw new Error(`无效的扣费金额: ${msg.cost}`);
      }
    
      if (!["user", "tenant"].includes(msg.account_type)) {
        throw new Error(`无效的账户类型: ${msg.account_type}`);
      }
    
      // 添加默认值
      const validatedMsg = {
        ...msg,
        input_tokens: msg.input_tokens || 0,
        output_tokens: msg.output_tokens || 0,
        total_tokens:
          msg.total_tokens ||
          (msg.input_tokens || 0) + (msg.output_tokens || 0),
        currency: msg.currency || "USD",
        timestamp: msg.timestamp || new Date().toISOString(),
        metadata: msg.metadata || {},
      };
    
      validMessages.push(validatedMsg);
    } catch (error) {
      invalidMessages.push({
        ...msg,
        validation_error: error.message,
      });
    }
  }

  return { validMessages, invalidMessages };
}

/**
 * 按账户分组消息
 */
  function groupMessagesByAccount(messages) {
    const groups = {};

  for (const msg of messages) {
    const key = `${msg.account_type}:${msg.account_id}`;
    if (!groups[key]) {
      groups[key] = {
        account_id: msg.account_id,
        account_type: msg.account_type,
        messages: [],
      };
    }

    groups[key].messages.push(msg);
  }

  return Object.values(groups);
}

/**
 * 批量插入 usage_log
 */
  async function insertUsageLogs(client, accountGroups) {
    if (accountGroups.length === 0) {
    return { inserted: 0, idMap: {} };
    }

  // 收集所有消息
  const allMessages = accountGroups.flatMap((group) => group.messages);

  // 构建批量INSERT
  const values = [];
  const params = [];
  let paramIndex = 1;

  for (const msg of allMessages) {
    values.push(`(
      $${paramIndex++},   -- deduction_id
      $${paramIndex++},   -- virtual_key
      $${paramIndex++},   -- account_id
      $${paramIndex++},   -- account_type
      $${paramIndex++},   -- provider
      $${paramIndex++},   -- model
      $${paramIndex++},   -- cost
      $${paramIndex++},   -- currency
      $${paramIndex++},   -- created_at
      $${paramIndex++},   -- input_tokens
      $${paramIndex++},   -- output_tokens
      $${paramIndex++},   -- metadata_json
      $${paramIndex++}    -- sync_status
    )`);

    params.push(
      msg.deduction_id,
      msg.virtual_key,
      msg.account_id,
      msg.account_type,
      msg.provider,
      msg.model,
      msg.cost,
      msg.currency,
      msg.timestamp,
      msg.input_tokens || 0,
      msg.output_tokens || 0,
      JSON.stringify(msg.metadata || {}),
      "completed",
    );
  }

  const query = `
    INSERT INTO data.usage_log (
      deduction_id, virtual_key, account_id, account_type,
      provider, model, cost, currency, created_at,
      input_tokens, output_tokens, metadata_json, sync_status
    ) VALUES ${values.join(", ")}
    ON CONFLICT (deduction_id) DO NOTHING
    RETURNING id, deduction_id
  `;

  try {
    const result = await client.query(query, params);
    const inserted = result.rowCount;

    // 构建 deduction_id -> usage_log_id 的映射
    const idMap = {};
    for (const row of result.rows) {
      idMap[row.deduction_id] = row.id;
    }
    
    console.log(`📝 插入 ${inserted} 条 usage_log 记录`);
    return { inserted, idMap };
  } catch (error) {
    console.error("插入 usage_log 失败:", error);
    throw error;
  }
}

/**
 * 批量插入 account_balance_audit
 */
  async function insertAuditLogs(client, accountGroups, idMap) {
    // 收集所有有 usage_log_id 的消息
    const auditMessages = [];

  for (const group of accountGroups) {
    for (const msg of group.messages) {
      const usageLogId = idMap[msg.deduction_id];
      if (usageLogId) {
        auditMessages.push({
          ...msg,
          usage_log_id: usageLogId,
        });
      }
    }
  }

  if (auditMessages.length === 0) {
    return { inserted: 0 };
  }

  // 构建批量INSERT
  const values = [];
  const params = [];
  let paramIndex = 1;

  for (const msg of auditMessages) {
    values.push(`(
      $${paramIndex++},   -- deduction_id
      $${paramIndex++},   -- account_id
      $${paramIndex++},   -- account_type
      $${paramIndex++},   -- amount (扣费为负数)
      $${paramIndex++},   -- source
      $${paramIndex++},   -- audit_category
      $${paramIndex++},   -- usage_log_id
      $${paramIndex++},   -- created_at
      $${paramIndex++}    -- sync_status
    )`);

    params.push(
      msg.deduction_id,
      msg.account_id,
      msg.account_type,
      -msg.cost, // 扣费为负数
      "api_gateway",
      "usage",
      msg.usage_log_id,
      msg.timestamp,
      "completed",
    );
  }

  const query = `
    INSERT INTO data.account_balance_audit (
      deduction_id, account_id, account_type, amount,
      source, audit_category, usage_log_id, created_at, sync_status
    ) VALUES ${values.join(", ")}
    ON CONFLICT (deduction_id) DO NOTHING
  `;

  try {
    const result = await client.query(query, params);
    const inserted = result.rowCount;

    console.log(`💰 插入 ${inserted} 条 audit 记录`);
    return { inserted };
  } catch (error) {
    console.error("插入 account_balance_audit 失败:", error);
    throw error;
  }
}

/**
 * 测试数据库连接
 */
 async function testConnection() {
    try {
    const client = await pool.connect();
    const result = await client.query("SELECT 1 as test");
    client.release();

    console.log("✅ 数据库连接正常");
    return { ok: true };
    } catch (error) {
    console.error("❌ 数据库连接失败:", error.message);
    return { ok: false, error: error.message };
    }
 }

module.exports = {
  writeDeductionBatch,
  testConnection,
};


变化: 为了完善可审计信息, 为usage_log 加入 balance_before和balance_after. 

请帮我指出需要修改的地方: 文件, 代码, 位置.





## 我的完整修改逻辑

### **核心目标**：
在现有的异步扣费流程中，为 `usage_log` 表添加 `balance_before`（扣费前余额）和 `balance_after`（扣费后余额）字段，实现完整的审计追溯。

### **系统流程回顾**：
```
用户请求 → API Gateway实时扣费(Redis) → 写入Stream → BillingWorker消费Stream → 写入数据库(usage_log)
```

### **我的修改逻辑**：

#### **阶段1：获取余额信息** (`balanceService.js`)
1. **扣费时获取余额**：
   - 修改 `chargeUser` Lua脚本：在扣费前保存 `balance_before`
   - 扣费后返回 `balance_before` 和 `balance_after`（new_balance）
   
2. **传递余额信息**：
   - 修改 `chargeForUsage`：将余额信息添加到Stream数据中
   ```javascript
   {
     ...其他字段,
     balance_before: context.account.balance,    // 从上下文获取扣费前余额
     balance_after: chargeResult.new_balance     // 从扣费结果获取扣费后余额
   }
   ```

#### **阶段2：传递余额信息** (`streamService.js`)
1. **更新Stream消息格式**：
   - 修改 `buildXAddArgs`：添加 `balance_before` 和 `balance_after` 字段到Redis Stream消息
   - 修改 `writeDeduction`：确保余额字段被序列化到消息中

#### **阶段3：处理余额信息** (`streamConsumer.js`)
1. **解析消息**：
   - `parseStreamMessages` 会自动解析Redis字段
   - 在转换为数据库格式时，确保余额字段被传递
   ```javascript
   balance_before: msg.balance_before ? parseFloat(msg.balance_before) : null,
   balance_after: msg.balance_after ? parseFloat(msg.balance_after) : null,
   ```

#### **阶段4：写入数据库** (`dbWriter.js`)
1. **验证余额数据**：
   - 在 `validateAndFilterMessages` 中添加余额验证逻辑
   - 类型检查、逻辑一致性检查（非阻塞警告）

2. **更新SQL插入**：
   - 修改 `insertUsageLogs`：添加 `balance_before` 和 `balance_after` 到INSERT语句
   - 修改参数列表和占位符

#### **阶段5：数据结构更新**（数据库迁移）
1. **表结构变更**：
   ```sql
   ALTER TABLE data.usage_log 
   ADD COLUMN balance_before NUMERIC(15,6),
   ADD COLUMN balance_after NUMERIC(15,6);
   ```

### **修改的关键原则**：

1. **向后兼容性**：
   - 余额字段是可选的（允许为null）
   - 旧消息没有余额信息也能正常处理

2. **渐进式部署**：
   - 先部署数据库迁移
   - 再部署代码修改
   - 新旧版本可以同时运行

3. **错误处理策略**：
   - 余额验证是警告而非错误
   - 防止数据问题阻塞整个流程

### **数据流示例**：
```
扣费时：
  账户余额: $100.00
  扣费金额: $1.50
  → balance_before: 100.00
  → balance_after: 98.50

Stream消息：
  Redis字段: "balance_before" "100.00" "balance_after" "98.50"

数据库记录：
  usage_log.balance_before: 100.00
  usage_log.balance_after: 98.50
```

### **为什么需要这两个字段？**

1. **审计追溯**：
   - 可以查询任何一笔扣费前后的账户状态
   - 便于排查异常扣费问题

2. **数据分析**：
   - 分析用户消费行为与余额的关系
   - 检测可能的刷单或异常行为

3. **对账功能**：
   - 与财务系统对账时，有完整的余额变更记录
   - 便于核对账户余额的准确性

### **风险控制**：

1. **余额不一致的处理**：
   - 如果 `balance_after ≠ balance_before - cost`，发出警告但不阻塞
   - 因为可能有并发充值/扣费操作

2. **null值处理**：
   - 旧消息或异常情况下余额字段可能为null
   - 应用层需要处理null值情况

### **完整数据链路**：
```
实时扣费 → 记录前后余额 → 写入Stream → 消费Stream → 验证余额逻辑 → 写入数据库
```

这样修改后，每个usage_log记录都包含了扣费时的完整余额上下文，大大增强了系统的可审计性。