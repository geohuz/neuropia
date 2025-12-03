const { Client } = require("pg");
const postgrest = require("../clients/postgrest");
const RedisService = require("@shared/clients/redis_op");
const CACHE_KEYS = require("../constants/cacheKeys");
const TTL = 30;

class BalanceService {
  static pgClient = null;
  static initialized = false;

  // ------------------------------
  // 初始化 pg_notify 监听
  // ------------------------------
  static async initialize() {
    if (this.initialized) return;

    this.pgClient = new Client({ connectionString: process.env.DATABASE_URL });
    await this.pgClient.connect();

    // 监听 account_balance 变动
    await this.pgClient.query("LISTEN account_balance_updated");

    this.pgClient.on("notification", async (msg) => {
      try {
        if (msg.channel === "account_balance_updated") {
          const payload = JSON.parse(msg.payload); // { owner_userid, owner_tenantid }
          console.log("account_balance_udpated: ", payload);
          await this.handleBalanceChange(payload);
        }
      } catch (err) {
        console.error("❌ Error handling balance pg notification:", err);
      }
    });

    this.initialized = true;
    console.log("✅ BalanceService initialized with pg_notify listening");
  }

  // ------------------------------
  // 处理账户余额变动
  // ------------------------------
  static async handleBalanceChange({ account_id, account_type }) {
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
  static async resolveBillingAccount(virtualKey) {
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
  static async ensureCache(account) {
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
  static async getBalanceByAccount(account) {
    const cacheKey = CACHE_KEYS.BALANCE(account.type, account.id);

    const cached = await RedisService.kv.get(cacheKey);
    if (cached) return JSON.parse(cached);

    // 查库
    const { data, error } = await postgrest
      .from("account_balance")
      .select("*")
      .eq(
        account.type === "tenant" ? "owner_tenantid" : "owner_userid",
        account.id,
      )
      .single();

    if (error || !data) throw new Error("BALANCE_NOT_FOUND");

    await RedisService.kv.setex(cacheKey, TTL, JSON.stringify(data));

    return data;
  }

  /**
   * 扣费单个账户
   * @param {{id: string, type: string, account: object}} account
   * @param {number|string} chargeAmount
   */
  static async chargeAccount(account, chargeAmount) {
    // 1. Redis key 必须是字符串
    const key = String(CACHE_KEYS.BALANCE(account.type, account.id));

    // 2. chargeAmount 必须转换为字符串
    const chargeStr = String(chargeAmount);

    // 3. 参数检查
    if (!key) throw new Error("Redis key is empty");
    if (!chargeStr || isNaN(Number(chargeStr)))
      throw new Error("chargeAmount is invalid");

    // 4. Lua 脚本
    const lua = `
          local key = KEYS[1]
          local charge = tonumber(ARGV[1])
          local balStr = redis.call("GET", key)

          if not balStr then
              return cjson.encode({ err="BALANCE_NOT_FOUND" })
          end

          local bal = cjson.decode(balStr)

          if bal.balance < charge then
              return cjson.encode({ err="INSUFFICIENT_BALANCE" })
          end

          bal.balance = bal.balance - charge
          redis.call("SET", key, cjson.encode(bal))

          return cjson.encode({ ok = bal.balance })
        `;

    // 5. 执行 Lua 脚本
    const client = await RedisService.connect(); // 获取 Redis client
    const rawResult = await client.eval(lua, {
      keys: [key],
      arguments: [chargeStr],
    });

    // 6. 解析返回结果
    const result = JSON.parse(rawResult);
    return result;
  }

  /**
   * 一步完成: 根据 virtual_key 获取余额
   */
  static async getBalance(vk) {
    const account = await this.resolveBillingAccount(vk);
    return await this.getBalanceByAccount(account);
  }

  /**
   * 一步完成: 根据 virtual_key 扣费
   */
  static async chargeUser(virtual_key, chargeAmount) {
    const account = await this.resolveBillingAccount(virtual_key);
    if (!account) throw new Error("ACCOUNT_NOT_FOUND");

    // 保证 Redis 缓存
    await this.ensureCache(account);

    // 扣费
    return await this.chargeAccount(account, chargeAmount);
  }
}

module.exports = BalanceService;
