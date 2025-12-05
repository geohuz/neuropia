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
