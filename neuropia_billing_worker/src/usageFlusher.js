// neuropia_billing_worker/src/usageFlusher.js
// - Redis 原子批量取 + 清空（防多实例重复消费）
// - PostgreSQL 批量 INSERT（VALUES 批量）
// - 无 for 循环单条写入
// - 安全支持多 worker 实例

const RedisService = require("@shared/clients/redis_op");
const pg = require("@shared/clients/pg");

const QUEUE_KEY = "usage_log_queue";
const BATCH_SIZE = 2000;

async function flushUsage() {
  let client;
  let db;

  try {
    client = await RedisService.connect();

    // ✅ 原子搬运队列 → 防止多实例重复消费
    const tmpKey = `${QUEUE_KEY}:flushing:${process.pid}`;
    await client.rename(QUEUE_KEY, tmpKey).catch(() => null);

    const items = await client.lRange(tmpKey, 0, BATCH_SIZE - 1);
    if (!items || items.length === 0) {
      await client.del(tmpKey);
      return;
    }

    const logs = items.map(JSON.parse);

    db = await pg.connect();
    await db.query("BEGIN");

    const values = logs
      .map(
        (_, i) =>
          `(
            $${i * 9 + 1}::uuid,
            $${i * 9 + 2}::text,
            $${i * 9 + 3}::text,
            $${i * 9 + 4}::int,
            $${i * 9 + 5}::numeric,
            $${i * 9 + 6}::int,
            $${i * 9 + 7}::int,
            $${i * 9 + 8}::timestamp,
            $${i * 9 + 9}::jsonb
          )`,
      )
      .join(",");

    const params = logs.flatMap((log) => [
      log.user_id ?? null,
      log.provider,
      log.model,
      log.tokens_used,
      log.cost,
      log.input_tokens ?? null,
      log.output_tokens ?? null,
      log.created_at,
      log,
    ]);

    await db.query(
      `
      INSERT INTO data.usage_log
      (
        user_id,
        provider,
        model,
        tokens_used,
        cost,
        input_tokens,
        output_tokens,
        created_at,
        metadata_json
      )
      VALUES ${values}
    `,
      params,
    );

    await db.query("COMMIT");

    // ✅ 删除已成功写入的 Redis 批次
    await client.del(tmpKey);

    console.log(`✅ flushed usage logs: ${logs.length}`);
  } catch (err) {
    if (db) await db.query("ROLLBACK").catch(() => {});
    console.error("❌ usage flusher failed:", err);
  } finally {
    if (db) db.release();
  }
}

module.exports = flushUsage;
