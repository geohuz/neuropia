// neuropia_billing_worker/src/streamConsumer.js
const RedisService = require("@shared/clients/redis_op");
const dbWriter = require("./dbWriter");

// 配置
const CONFIG = {
  // Stream配置
  streamPrefix: "stream:deductions",
  numShards: 16,
  consumerGroup: "billing_workers",
  consumerName: `worker_${process.pid}_${Date.now()}`,

  // 消费策略
  batchSize: 50, // 每批处理50条
  pollInterval: 100, // 轮询间隔100ms
  blockTime: 5000, // 阻塞读取超时5秒

  // 重试策略
  maxRetries: 3, // 最大重试次数
  retryDelay: 1000, // 重试延迟1秒（指数退避）

  // 监控（预留stub）
  enableMetrics: false, // TODO: 监控指标
  enableDeadLetter: false, // TODO: 死信队列
};

/**
 * 启动Stream消费者
 */
async function startStreamConsumer(userConfig = {}) {
  const config = { ...CONFIG, ...userConfig };

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
    // TODO: 发送报警
    throw error;
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

  while (true) {
    let messages = [];
    let shardIndex = null;

    try {
      // 1. 读取消息（轮询所有分片）
      const readResult = await readMessagesFromStreams(config);
      messages = readResult.messages;
      shardIndex = readResult.shardIndex;

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
}

/**
 * 从所有分片读取消息（轮询）
 */
async function readMessagesFromStreams(config) {
  const client = await RedisService.connect();

  // 轮询所有分片，直到找到有消息的分片
  for (let shardIndex = 0; shardIndex < config.numShards; shardIndex++) {
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
      console.error(`❌ 读取分片 ${shardIndex} 失败:`, error.message);
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
 * 停止消费者（预留接口）
 */
async function stopConsumer() {
  console.log("🛑 停止Stream消费者...");
  // TODO: 实现优雅关闭
  // 1. 停止消费循环
  // 2. 完成正在处理的批次
  // 3. 发送所有ACK
  // 4. 清理资源
}

module.exports = {
  startStreamConsumer,
  stopConsumer, // 预留
  // 导出配置供测试
  CONFIG,
};
