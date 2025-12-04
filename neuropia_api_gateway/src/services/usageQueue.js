const RedisService = require("@shared/clients/redis_op");

const USAGE_QUEUE_KEY = "usage_log_queue";

class UsageQueue {
  static async push(log) {
    const client = await RedisService.connect();
    await client.rPush(USAGE_QUEUE_KEY, JSON.stringify(log));
  }
}

module.exports = UsageQueue;
