// neuropia_billing_worker/src/streamConsumer.js
const RedisService = require("@shared/clients/redis_op");
const dbWriter = require("./dbWriter");
const CONFIG = require("./consumerConfig");
const logger = require("@shared/utils/logger");

const config = {
  ...CONFIG,
  consumerName: `worker_${process.pid}_${Date.now()}`,
};

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

  logger.info("🚀 启动Stream消费者:", {
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
    logger.error("Stream消费者启动失败:", {
      error: error.message,
      stack: error.stack,
    });
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

      logger.info(`✅ 初始化消费者组: ${streamKey} -> ${config.consumerGroup}`);
    } catch (error) {
      // 消费者组可能已存在（BUSYGROUP错误）
      if (!error.message.includes("BUSYGROUP")) {
        logger.error(`❌ 初始化消费者组失败 ${streamKey}:`, {
          error: error.message,
          stack: error.stack,
        });
        // TODO: 记录到监控
      }
    }
  }
}

/**
 * 主消费循环
 */
/**
 * 主消费循环
 */
async function consumeLoop(config) {
  logger.info("进入消费循环...", {
    batchMode: config.batchMode,
    batchSize: config.batchSize,
    parallelShards: config.parallelShards,
  });

  let loopCounter = 0;

  while (!shouldStopConsuming) {
    loopCounter++;
    let messages = [];
    let shardIndex = null;

    try {
      // 定期记录心跳（每100次循环）
      if (loopCounter % 100 === 0) {
        logger.info(`❤️  消费循环心跳: ${loopCounter}次`, {
          batchMode: config.batchMode,
        });
      }

      // 1. 读取消息（轮询所有分片）
      const readResult = await readMessagesFromStreams(config);
      messages = readResult.messages;
      shardIndex = readResult.shardIndex;

      // 🎯 检查是否应该停止
      if (shouldStopConsuming) {
        logger.info("🛑 收到停止信号，退出消费循环");
        break;
      }

      if (messages.length === 0) {
        // 🎯 根据批量模式调整休眠策略
        if (config.batchMode === "on") {
          // 批量模式：正常休眠
          await sleep(config.pollInterval);
        } else {
          // 单条模式：短时间休眠，立即重试
          await sleep(10); // 10ms短休眠
        }
        continue;
      }

      logger.info(`📨 从分片 ${shardIndex} 读取到 ${messages.length} 条消息`, {
        shardIndex: shardIndex,
        msgLen: messages.length,
        batchMode: config.batchMode,
        expectedBatchSize: config.batchSize,
      });

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
      logger.error("❌ 消费循环内部错误:", {
        message: error.message,
        stack: error.stack,
        loopCount: loopCounter,
        batchMode: config.batchMode,
      });

      // 🎯 检查是否应该停止
      if (shouldStopConsuming) {
        logger.info("🛑 收到停止信号，退出消费循环");
        break;
      }

      logger.error("❌ 消费循环错误:", error);

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

  logger.info("✅ 消费循环已停止", { batchMode: config.batchMode });
}

/**
 * 从所有分片读取消息（轮询）
 */
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
      // 🎯 根据批量模式调整读取数量
      const readCount = config.batchMode === "on" ? config.batchSize : 1;

      // 使用消费者组读取
      const result = await client.sendCommand([
        "XREADGROUP",
        "GROUP",
        config.consumerGroup,
        config.consumerName,
        "COUNT",
        readCount.toString(),
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
        logger.warn(`⚠️ Stream不存在，尝试创建: ${streamKey}`);
        try {
          await client.sendCommand([
            "XGROUP",
            "CREATE",
            streamKey,
            config.consumerGroup,
            "0",
            "MKSTREAM",
          ]);
          logger.log(`✅ 重新创建Stream: ${streamKey}`);
        } catch (createError) {
          if (!createError.message.includes("BUSYGROUP")) {
            logger.error(`❌ 创建Stream失败: ${createError.message}`);
          }
        }
      } else {
        logger.error(`❌ 读取分片 ${shardIndex} 失败:`, error.message);
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
    logger.error("❌ 解析Stream消息失败:", error);
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

  logger.debug("处理消息批次", {
    count: messages.length,
    batchMode: config.batchMode,
    expectedBatchSize: config.batchSize,
  });

  try {
    // 1. 转换为dbWriter需要的格式
    const dbMessages = messages.map((msg) => {
      let user_id = null;
      let tenant_id = null;

      if (msg.account_type === "user" && msg.account_owner_id) {
        user_id = msg.account_owner_id;
      } else if (msg.account_type === "tenant" && msg.account_owner_id) {
        tenant_id = msg.account_owner_id;
      }

      return {
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
        // 🎯 关键修复：添加余额字段
        balance_before:
          msg.balance_before !== undefined
            ? typeof msg.balance_before === "number"
              ? msg.balance_before
              : parseFloat(msg.balance_before)
            : null,
        balance_after:
          msg.balance_after !== undefined
            ? typeof msg.balance_after === "number"
              ? msg.balance_after
              : parseFloat(msg.balance_after)
            : null,
        user_id: user_id,
        tenant_id: tenant_id,
      };
    });

    // 2. 调用dbWriter写入数据库
    const writeResult = await dbWriter.writeDeductionBatch(dbMessages, {
      batchSize: config.batchSize,
      skipInvalid: true,
    });

    // 3. 收集处理成功的消息ID
    for (const msg of messages) {
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

    logger.info(`✅ 处理完成: ${writeResult.written_usage_log} usage_log 记录`);

    return {
      success: true,
      processedIds,
      failedMessages,
      duration: Date.now() - startTime,
      writeResult,
    };
  } catch (error) {
    logger.error("❌ 处理消息批次失败:", error);

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

  logger.debug("发送ACK确认", {
    shardIndex,
    count: messageIds.length,
    batchMode: config.batchMode,
  });

  const streamKey = `${config.streamPrefix}:${shardIndex}`;
  const client = await RedisService.connect();

  try {
    // 批量发送ACK
    for (const messageId of messageIds) {
      // 🎯 检查是否应该停止
      if (shouldStopConsuming) {
        logger.info("🛑 停止过程中，跳过剩余ACK");
        break;
      }
      await client.sendCommand([
        "XACK",
        streamKey,
        config.consumerGroup,
        messageId,
      ]);
    }

    logger.info(`✅ 发送ACK: 分片 ${shardIndex}, ${messageIds.length} 条消息`);

    // TODO: 监控 - ACK成功率
    // metrics.increment('stream.ack.success', messageIds.length);
  } catch (error) {
    logger.error(`❌ 发送ACK失败 ${streamKey}:`, error);

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

  logger.warn(`⚠️ 有 ${failedMessages.length} 条消息处理失败`);

  // TODO: 实现失败处理策略
  // 1. 临时错误：加入重试队列
  // 2. 永久错误：记录到死信队列
  // 3. 发送报警

  // 暂时简单记录日志
  failedMessages.forEach(({ message, error }, index) => {
    logger.error(`失败消息 ${index + 1}:`, {
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
  logger.info("🛑 停止Stream消费者...");

  if (!isConsuming) {
    logger.info("ℹ️ Stream消费者未运行");
    return;
  }

  // 1. 设置停止标志
  shouldStopConsuming = true;

  // 2. 等待消费循环停止（最多10秒）
  const maxWaitTime = 10000;
  const startWait = Date.now();

  while (isConsuming && Date.now() - startWait < maxWaitTime) {
    logger.info("⏳ 等待消费循环停止...");
    await sleep(500);
  }

  if (isConsuming) {
    logger.warn("⚠️ 消费循环未在10秒内停止，可能卡住了");
  } else {
    logger.info("✅ Stream消费者已停止");
  }

  return true;
}

module.exports = {
  startStreamConsumer,
  stopConsumer,
  // 导出配置供测试
  CONFIG,
};
