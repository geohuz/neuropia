const RedisService = require("@shared/clients/redis_op");
const pg = require("@shared/clients/pg");

async function flushBalances() {
  const lockKey = "lock:balance:flusher";
  const LOCK_TTL = 10; // 秒

  let lock;
  try {
    const client = await RedisService.connect();

    // ✅ 分布式锁（防多实例重复 flush）
    lock = await client.set(lockKey, "1", {
      NX: true,
      EX: LOCK_TTL,
    });

    if (!lock) {
      // 其他实例正在 flush，直接退出
      return;
    }

    let cursor = "0";
    const rows = [];

    do {
      const res = await client.scan(cursor, {
        MATCH: "balance:*",
        COUNT: 1000,
      });

      cursor = res.cursor;
      const keys = res.keys;

      for (const key of keys) {
        const raw = await client.get(key);
        if (!raw) continue;

        const bal = JSON.parse(raw);
        const [, type, id] = key.split(":");

        rows.push({
          type,
          id,
          balance: bal.balance,
          redisKey: key, // ✅ 记住 key，后面要 DEL
        });
      }
    } while (cursor !== "0");

    if (rows.length === 0) return;

    const db = await pg.connect();

    try {
      await db.query("BEGIN");

      const userRows = rows.filter((r) => r.type === "user");
      if (userRows.length > 0) {
        const values = userRows
          .map((r, i) => `($${i * 2 + 1}::uuid, $${i * 2 + 2}::numeric)`)
          .join(",");

        const params = userRows.flatMap((r) => [r.id, r.balance]);

        await db.query(
          `
          UPDATE data.account_balance AS ab
          SET balance = v.balance
          FROM (VALUES ${values}) AS v(id, balance)
          WHERE ab.owner_userid = v.id
        `,
          params,
        );
      }

      const tenantRows = rows.filter((r) => r.type === "tenant");
      if (tenantRows.length > 0) {
        const values = tenantRows
          .map((r, i) => `($${i * 2 + 1}::uuid, $${i * 2 + 2}::numeric)`)
          .join(",");

        const params = tenantRows.flatMap((r) => [r.id, r.balance]);

        await db.query(
          `
          UPDATE data.account_balance AS ab
          SET balance = v.balance
          FROM (VALUES ${values}) AS v(id, balance)
          WHERE ab.owner_tenantid = v.id
        `,
          params,
        );
      }

      await db.query("COMMIT");

      // ✅ flush 成功后，删除 Redis key，避免重复刷
      for (const row of rows) {
        await client.del(row.redisKey);
      }

      console.log(`✅ flushed balances: ${rows.length}`);
    } catch (e) {
      await db.query("ROLLBACK");
      console.error("❌ balance flush failed", e);
    } finally {
      db.release();
    }
  } catch (err) {
    console.error("❌ balance flusher outer error", err);
  } finally {
    // ✅ 清理锁
    if (lock) {
      try {
        const client = await RedisService.connect();
        await client.del("lock:balance:flusher");
      } catch {}
    }
  }
}

module.exports = flushBalances;
