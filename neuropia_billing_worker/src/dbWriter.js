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
    // written_audit_log: 0,
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

    // if (usageLogResult.idMap && Object.keys(usageLogResult.idMap).length > 0) {
    //   // 6. 批量写入 account_balance_audit
    //   const auditLogResult = await insertAuditLogs(
    //     client,
    //     groupedByAccount,
    //     usageLogResult.idMap,
    //   );
    //   result.written_audit_log = auditLogResult.inserted;
    // }

    // 7. 提交事务（不写daily_summary！）
    await client.query("COMMIT");

    console.log(`✅ 批次 ${batchId} 处理完成:
      有效消息: ${result.valid_messages}
      usage_log: ${result.written_usage_log}`);
    // audit_log: ${result.written_audit_log}`);
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

      // 可选字段验证
      if (
        msg.input_tokens !== undefined &&
        (typeof msg.input_tokens !== "number" || msg.input_tokens < 0)
      ) {
        throw new Error(`无效的输入token数量: ${msg.input_tokens}`);
      }

      if (
        msg.output_tokens !== undefined &&
        (typeof msg.output_tokens !== "number" || msg.output_tokens < 0)
      ) {
        throw new Error(`无效的输出token数量: ${msg.output_tokens}`);
      }

      if (
        msg.total_tokens !== undefined &&
        (typeof msg.total_tokens !== "number" || msg.total_tokens < 0)
      ) {
        throw new Error(`无效的总token数量: ${msg.total_tokens}`);
      }

      // 🆕 余额字段验证
      if (msg.balance_before !== undefined) {
        if (typeof msg.balance_before !== "number") {
          throw new Error(`无效的扣费前余额类型: ${typeof msg.balance_before}`);
        }
        if (msg.balance_before < 0) {
          console.warn(`⚠️ 扣费前余额为负数: ${msg.balance_before}`, {
            deduction_id: msg.deduction_id,
            account_id: msg.account_id,
          });
        }
      }

      if (msg.balance_after !== undefined) {
        if (typeof msg.balance_after !== "number") {
          throw new Error(`无效的扣费后余额类型: ${typeof msg.balance_after}`);
        }
        if (msg.balance_after < 0) {
          console.warn(`⚠️ 扣费后余额为负数: ${msg.balance_after}`, {
            deduction_id: msg.deduction_id,
            account_id: msg.account_id,
          });
        }
      }

      // 🆕 余额逻辑一致性检查（如果两个余额都存在）
      if (msg.balance_before !== undefined && msg.balance_after !== undefined) {
        const expectedBalanceAfter = msg.balance_before - msg.cost;
        const balanceDiff = Math.abs(msg.balance_after - expectedBalanceAfter);

        // 允许小的浮点数误差
        if (balanceDiff > 0.0001) {
          console.warn(
            `⚠️ 余额不一致: before(${msg.balance_before}) - cost(${msg.cost}) = ${expectedBalanceAfter}, but after is ${msg.balance_after}, diff=${balanceDiff}`,
            {
              deduction_id: msg.deduction_id,
              account_id: msg.account_id,
            },
          );
          // 🆕 这里可以选择修正或标记，不抛出错误
          // 因为可能是并发操作导致的不一致
        }

        // 如果扣费后余额大于扣费前，发出警告
        if (msg.balance_after > msg.balance_before) {
          console.warn(
            `⚠️ 扣费后余额大于扣费前余额: after(${msg.balance_after}) > before(${msg.balance_before})`,
            {
              deduction_id: msg.deduction_id,
              account_id: msg.account_id,
              cost: msg.cost,
            },
          );
        }
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
        // 🆕 确保余额字段存在（即使为null）
        balance_before:
          msg.balance_before !== undefined ? msg.balance_before : null,
        balance_after:
          msg.balance_after !== undefined ? msg.balance_after : null,
      };

      validMessages.push(validatedMsg);
    } catch (error) {
      invalidMessages.push({
        ...msg,
        validation_error: error.message,
      });

      console.error("消息验证失败:", {
        deduction_id: msg.deduction_id,
        error: error.message,
        data: msg,
      });
    }
  }

  // 输出验证统计
  if (invalidMessages.length > 0) {
    console.warn(
      `⚠️ 发现 ${invalidMessages.length} 条无效消息，${validMessages.length} 条有效消息`,
    );

    // 可以按错误类型分类统计
    const errorStats = {};
    invalidMessages.forEach((msg) => {
      const errorType = msg.validation_error.split(":")[0] || "unknown";
      errorStats[errorType] = (errorStats[errorType] || 0) + 1;
    });

    console.warn("无效消息错误统计:", errorStats);
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
      $${paramIndex++},   -- sync_status
      $${paramIndex++},   -- 🆕 balance_before
      $${paramIndex++},   -- 🆕 balance_after
      $${paramIndex++},   -- 🆕 user_id
      $${paramIndex++}    -- 🆕 tenant_id
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
      msg.balance_before || null, // 🆕
      msg.balance_after || null, // 🆕
      msg.user_id || null, // 🆕 直接从msg中取 from dbMessage
      msg.tenant_id || null, // 🆕 直接从msg中取
    );
  }

  const query = `
    INSERT INTO data.usage_log (
      deduction_id, virtual_key, account_id, account_type,
      provider, model, cost, currency, created_at,
      input_tokens, output_tokens, metadata_json, sync_status,
      balance_before, balance_after, user_id, tenant_id
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
