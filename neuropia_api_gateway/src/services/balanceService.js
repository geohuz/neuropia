const postgrest = require("../clients/postgrest");
const RedisService = require("@shared/clients/redis_op");
const CACHE_KEYS = require("../constants/cacheKeys");
const pgNotifyListener = require("../listeners/pgNotifyListener");
const { ALL_CHANNELS } = require("../constants/pgNotifyChannels");

const TTL = 86400; // 24 小时

class BalanceService {
  constructor() {
    this.initialized = false;
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
  async handleBalanceChange({ account_id, account_type }) {
    try {
      // 1️⃣ 删除余额缓存
      const balanceKey = CACHE_KEYS.BALANCE(account_type, account_id);
      await RedisService.kv.del(balanceKey);
      console.log(`🧹 Balance cache invalidated: ${balanceKey}`);

      // 2️⃣ 删除 billing_account 缓存
      let query = postgrest.from("virtual_keys").select("virtual_key");

      if (account_type === "user") {
        query = query.eq("user_id", account_id);
      } else if (account_type === "tenant") {
        query = query.eq("tenant_id", account_id);
      } else {
        console.warn("⚠️ Unknown account_type:", account_type);
        return;
      }

      const { data: vks, error } = await query;

      if (error) {
        console.error(
          "❌ Failed to get virtual_keys for balance invalidation",
          error,
        );
        return;
      }

      if (Array.isArray(vks)) {
        for (const { virtual_key } of vks) {
          const billingKey = CACHE_KEYS.BILLING_ACCOUNT(virtual_key);
          await RedisService.kv.del(billingKey);
          console.log(`🧹 Billing account cache invalidated: ${billingKey}`);
        }
      }
    } catch (err) {
      console.error("❌ Unexpected error in handleBalanceChange:", err);
    }
  }

  /**
   * 根据 virtual_key 解析实际扣费账户
   */
  async resolveBillingAccount(virtualKey) {
    if (!virtualKey) throw new Error("INVALID_VIRTUAL_KEY");

    const redisKey = CACHE_KEYS.BILLING_ACCOUNT(virtualKey);

    // 1. Redis 先查缓存
    const cached = await RedisService.kv.get(redisKey);
    if (cached) return JSON.parse(cached);

    // 2. 查 billing_accounts view
    const { data: accountData, error } = await postgrest
      .from("billing_accounts")
      .select("*")
      .eq("virtual_key", virtualKey)
      .single();

    console.log(error, accountData);
    if (error || !accountData) throw new Error("ACCOUNT_NOT_FOUND");

    // 3. 格式统一
    const result = {
      id: accountData.account_id,
      type: accountData.account_type,
      account: {
        balance: accountData.balance,
        overdue_amount: accountData.overdue_amount,
      },
    };

    // 4. 写缓存
    await RedisService.kv.setex(redisKey, TTL, JSON.stringify(result));

    return result;
  }

  /**
   * 确保 Redis 余额缓存存在
   */
  async ensureCache(account) {
    // account: { id, type, account }
    const key = CACHE_KEYS.BALANCE(account.type, account.id);

    // 1. 先查 Redis
    const cached = await RedisService.kv.get(key);
    if (cached) return JSON.parse(cached);

    // 2. 如果 Redis 没有，用 account.account 作为权威数据
    const balanceObj = account.account; // ✓ resolveBillingAccount 返回的是 .account

    if (!balanceObj) {
      throw new Error("INVALID_ACCOUNT: missing account.account");
    }

    // 3. 写入 Redis
    await RedisService.kv.setex(key, TTL, JSON.stringify(balanceObj));

    return balanceObj;
  }

  /**
   * 获取账户余额
   */
  async getBalanceByAccount(account) {
    const cacheKey = CACHE_KEYS.BALANCE(account.type, account.id);

    const cached = await RedisService.kv.get(cacheKey);
    if (cached) return JSON.parse(cached);

    // 查库
    const { data, error } = await postgrest
      .from("account_balances")
      .select("*")
      .eq(
        account.type === "tenant" ? "owner_tenantid" : "owner_userid",
        account.id,
      )
      .single();

    if (error || !data) {
      console.log("error in getBalanceByAccount", error);
      throw new Error("BALANCE_NOT_FOUND");
    }

    await RedisService.kv.setex(cacheKey, TTL, JSON.stringify(data));

    return data;
  }

  /**
   * 扣费单个账户
   * @param {{id: string, type: string, account: object}} account
   * @param {number|string} chargeAmount
   */

  /**
   * 一步完成: 根据 virtual_key 获取余额
   */
  async getBalance(vk) {
    const account = await this.resolveBillingAccount(vk);
    return await this.getBalanceByAccount(account);
  }

  /**
   * 一步完成: 根据 virtual_key 扣费
   */
  /**
   * 一步完成: 根据 virtual_key 扣费
   */
  async chargeUser(virtual_key, chargeAmount) {
    if (!virtual_key || !chargeAmount) {
      throw new Error("MISSING_PARAMS");
    }

    // 1. 解析扣费账户
    const account = await this.resolveBillingAccount(virtual_key);
    if (!account) {
      throw new Error("ACCOUNT_NOT_FOUND");
    }

    // 2. 保证 Redis 缓存存在
    await this.ensureCache(account);

    // 3. 准备扣费参数
    const key = String(CACHE_KEYS.BALANCE(account.type, account.id));
    const chargeStr = String(chargeAmount);

    if (!key) {
      throw new Error("REDIS_KEY_EMPTY");
    }

    if (!chargeStr || isNaN(Number(chargeStr)) || Number(chargeStr) <= 0) {
      throw new Error("INVALID_CHARGE_AMOUNT");
    }

    // 4. Lua 脚本扣费
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

    // 5. 执行 Lua 脚本
    const client = await RedisService.connect();
    const rawResult = await client.eval(lua, {
      keys: [key],
      arguments: [chargeStr],
    });

    // 6. 解析返回结果
    const result = JSON.parse(rawResult);

    if (result.err) {
      throw new Error(result.err);
    }

    console.log(
      `✅ 扣费成功: ${virtual_key}, 扣费金额: ${chargeAmount}, 新余额: ${result.new_balance}`,
    );

    return result;
  }
}

const balanceService = new BalanceService();
module.exports = balanceService;
