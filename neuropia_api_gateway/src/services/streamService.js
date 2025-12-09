// services/streamService.js
/*
TODO（需要外部系统）
错误监控和报警
重试队列机制
失败补偿存储
*/
const RedisService = require("@shared/clients/redis_op");
const logger = require("@shared/utils/logger");

// 配置
const BATCH_SIZE = parseInt(process.env.PRODUCER_BATCH_SIZE) || 50;
const NUM_SHARDS = parseInt(process.env.STREAM_SHARD_COUNT) || 16;
const MAX_LEN = parseInt(process.env.STREAM_MAX_LEN) || 10000;
const STREAM_PREFIX = "stream:deductions";

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
  const args = [
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
    "account_owner_id",
    message.account_owner_id?.toString() || message.account_owner_id || "",
    "trace_id",
    message.trace_id
  ];

  // 🆕 添加余额信息
  if (message.balance_before !== undefined) {
    args.push("balance_before", message.balance_before.toString());
  }
  if (message.balance_after !== undefined) {
    args.push("balance_after", message.balance_after.toString());
  }

  return args;
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
      // 🆕 新增余额字段
      balance_before: deductionData.balance_before,
      balance_after: deductionData.balance_after,
      account_owner_id: deductionData.account_owner_id,
      trace_id: deductionData.trace_id,
    };

    const client = await RedisService.connect();
    const args = buildXAddArgs(streamKey, message);
    await client.sendCommand(args);

    logger.info(`✅ Stream写入成功: ${deductionId} -> ${streamKey}`);

    return {
      success: true,
      deduction_id: deductionId,
      stream_key: streamKey,
    };
  } catch (error) {
    logger.error("❌ Stream写入失败:", error.message);

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
      balance_before: deduction.balance_before,
      balance_after: deduction.balance_after,
      account_owner_id: deduction.account_owner_id,
      trace_id: deduction.trace_id,
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
        const multi = client.multi();

        for (const message of batch) {
          multi.xAdd(streamKey, "*", {
            deduction_id: message.deduction_id,
            account_id: message.account_id,
            account_type: message.account_type,
            virtual_key: message.virtual_key,
            cost: message.cost.toString(),
            currency: message.currency,
            provider: message.provider,
            model: message.model,
            input_tokens: message.input_tokens.toString(),
            output_tokens: message.output_tokens.toString(),
            total_tokens: message.total_tokens.toString(),
            timestamp: message.timestamp,
            account_owner_id: message.account_owner_id || "",
            ...(message.balance_before !== undefined && {
              balance_before: message.balance_before.toString(),
            }),
            ...(message.balance_after !== undefined && {
              balance_after: message.balance_after.toString(),
            }),
            trace_id: message.trace_id,
          });
        }

        const pipelineResults = await multi.exec();

        for (let j = 0; j < batch.length; j++) {
          const message = batch[j];
          const [error, result] = pipelineResults[j] || [null, null];

          results.push({
            success: !error,
            deduction_id: message.deduction_id,
            stream_key: streamKey,
            error: error ? error.message : null,
            result: result,
          });
        }

        logger.info(
          `✅ Stream批量写入: ${streamKey}, 批次 ${Math.floor(i / BATCH_SIZE) + 1}, 数量 ${batch.length}`,
        );
      } catch (error) {
        for (const message of batch) {
          results.push({
            success: false,
            deduction_id: message.deduction_id,
            stream_key: streamKey,
            error: error.message,
          });
        }

        logger.error(`❌ Stream批量写入失败: ${streamKey}`, {
          error: error.message,
          stack: error.stack,
        });
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
        logger.log(`🧹 Stream清理: ${streamKey}, 清理 ${cleaned} 条消息`);
      }
    } catch (error) {
      cleanupStats.errors.push({
        shard: shardIndex,
        error: error.message,
      });
      logger.error(`❌ Stream清理失败: ${streamKey}`, {
        error: error.message,
        stack: error.stack,
      });
    }
  }

  return cleanupStats;
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
  logger.warn("Stream读取功能未实现");
  return [];
}

/**
 * 确认消息处理完成 - 预留
 */
async function ackMessage(shardIndex, consumerGroup, messageId) {
  // TODO: 实现消息ACK确认
  logger.warn("Stream ACK功能未实现");
  return false;
}

/**
 * 创建消费者组 - 预留
 */
async function createConsumerGroup(shardIndex, groupName) {
  // TODO: 创建消费者组
  logger.warn("创建消费者组功能未实现");
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

  // 预留的（stub）
  readDeductions,
  ackMessage,
  createConsumerGroup,

  // 工具函数
  getShardKey,
  generateDeductionId,
};
