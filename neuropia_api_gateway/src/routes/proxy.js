// neuropia_api_gateway/src/routes/proxy.js
// const { portkeyConfigSchema } = require("../validation/portkey_schema_config");
const { ConfigService } = require("../services/configService");
const balanceService = require("../services/balanceService");
const logger = require("@shared/utils/logger"); // 假设你创建了logger
const express = require("express");
const router = express.Router();
const GatewayControlService = require("../services/gatewayControlService");
// const { handleTestMode } = require("./testModeHandler");

const {
  trackApiRequest,
  trackError,
} = require("../services/monitoringService");

router.all("/*", async (req, res) => {
  const startTime = Date.now();
  const traceId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  try {
    const { userContext } = req;
    const { virtual_key } = userContext;
    const requestBody = req.body;
    const originalPath = req.path;

    logger.info("开始代理请求", {
      traceId,
      virtual_key,
      path: originalPath,
      method: req.method,
    });

    // 🎯 在这里插入测试模式检测
    // const isTestRequest = virtual_key.startsWith("test_vk_");

    // if (isTestRequest) {
    //   logger.info("测试模式请求", {
    //     traceId,
    //     virtual_key,
    //   });

    //   // 测试模式：模拟AI响应 + 真实扣费
    //   return await handleTestMode(req, res, {
    //     traceId,
    //     userContext,
    //     // portkeyConfig: {},
    //     requestBody,
    //     // originalPath,
    //     startTime,
    //   });
    // }

    // 1. 获取配置（失败直接抛出）
    let portkeyConfig;
    try {
      portkeyConfig = await ConfigService.getAllConfigs(
        userContext,
        requestBody,
      );
      logger.debug("配置获取成功", { traceId, virtual_key });
    } catch (configError) {
      logger.error("配置获取失败，尝试降级配置", {
        traceId,
        virtual_key,
        error: configError.message,
      });

      // ✅ 降级配置是备选方案，不是默认
      portkeyConfig = getFallbackConfig(userContext, requestBody);
      if (!portkeyConfig) {
        throw new Error(`配置服务不可用且无降级配置: ${configError.message}`);
      }
      logger.warn("使用降级配置", { traceId, virtual_key });
    }

    // 2. 验证配置结构
    if (
      !portkeyConfig.targets ||
      !Array.isArray(portkeyConfig.targets) ||
      portkeyConfig.targets.length === 0
    ) {
      const error = new Error("无效配置: targets缺失或为空");
      error.context = { config: portkeyConfig };
      throw error;
    }

    // 3. 业务规则验证
    try {
      await validateBusinessRules(
        userContext,
        requestBody,
        originalPath,
        traceId,
      );
    } catch (validationError) {
      // 业务规则验证失败直接返回给客户端
      logger.warn("业务规则验证失败", {
        traceId,
        virtual_key,
        error: validationError.message,
      });
      throw validationError; // 继续向上抛，让上层处理HTTP响应
    }

    logger.debug(
      "api_gateway 发送到portkey ai gateway的x-portkey-config: ",
      portkeyConfig,
    );
    // 4. 调用 Portkey Gateway
    const portkeyResponse = await callPortkeyGateway(
      portkeyConfig,
      requestBody,
      userContext,
      originalPath,
      traceId,
    );

    const duration = Date.now() - startTime;
    logger.info("请求处理完成", {
      traceId,
      virtual_key,
      duration,
      status: "success",
    });

    res.json(portkeyResponse);
  } catch (error) {
    const duration = Date.now() - startTime;

    // ✅ 记录完整错误信息（堆栈+上下文）
    logger.error("代理请求失败", {
      traceId,
      virtual_key: req.userContext?.virtual_key,
      path: req.path,
      duration,
      error: error.message,
      stack: error.stack, // ✅ 关键：保留堆栈
      code: error.code,
    });

    // ✅ 根据错误类型返回不同的HTTP状态码
    if (
      error.code === "MODEL_NOT_ALLOWED" ||
      error.message.includes("不在允许列表中")
    ) {
      return res.status(403).json({
        traceId,
        error: error.message,
        code: "MODEL_NOT_ALLOWED",
        trace_id: traceId,
      });
    }

    if (
      error.code === "INSUFFICIENT_BALANCE" ||
      error.message.includes("余额不足")
    ) {
      return res.status(402).json({
        // 402 Payment Required
        traceId,
        error: error.message,
        code: "INSUFFICIENT_BALANCE",
        trace_id: traceId,
      });
    }

    if (
      error.code === "RATE_LIMIT_EXCEEDED" ||
      error.message.includes("频率超限")
    ) {
      return res.status(429).json({
        traceId,
        error: error.message,
        code: "RATE_LIMIT_EXCEEDED",
        trace_id: traceId,
      });
    }

    if (error.message.includes("BILLING_FAILED")) {
      return res.status(500).json({
        error: "计费系统错误",
        code: "BILLING_FAILED",
        trace_id: traceId,
      });
    }

    // 其他错误
    res.status(500).json({
      error: "内部服务器错误",
      code: "INTERNAL_ERROR",
      trace_id: traceId,
      // 生产环境不返回详情，开发环境可以
      details:
        process.env.NODE_ENV === "production" ? undefined : error.message,
    });
  }
});

async function validateBusinessRules(userContext, requestBody, path, traceId) {
  /*
  const { sync_controls } = metadata;
  if (!sync_controls) return;

  const { model_access, rate_limits, budget } = sync_controls;
  */

  // // 1. 检查模型权限
  // if (path.includes("/chat/completions") || path.includes("/completions")) {
  //   if (model_access?.allowed_models) {
  //     const model = requestBody.model;
  //     if (!model) {
  //       throw new Error("请求缺少model参数");
  //     }

  //     if (!model_access.allowed_models.includes(model)) {
  //       const error = new Error(`模型 ${model} 不在允许列表中`);
  //       error.code = "MODEL_NOT_ALLOWED";
  //       throw error;
  //     }
  //   }
  // }

  // 2. 预算检查
  try {
    const billingContext = await checkBudget(
      {},
      userContext,
      requestBody,
      path,
      traceId,
    );
    userContext.billingContext = billingContext;
  } catch (budgetError) {
    // 预算检查失败，直接抛出
    throw budgetError;
  }

  // 3. 限流检查
  try {
    await checkRateLimits(userContext, requestBody, path, traceId);
  } catch (rateLimitError) {
    rateLimitError.code = "RATE_LIMIT_EXCEEDED";
    throw rateLimitError;
  }
}

async function checkBudget(
  budgetConfig,
  userContext,
  requestBody,
  path,
  traceId,
) {
  const { virtual_key } = userContext;

  try {
    const billingContext = await balanceService.getBillingContext(virtual_key);
    const account = billingContext.account;

    const user = {
      tenant_id: account.type === "tenant" ? account.account_owner_id : null,
      customer_type: account.customer_type_id,
      id: account.type === "user" ? account.account_owner_id : null,
    };

    const balanceCheckResult = await GatewayControlService.checkBalance(
      user,
      0, // 预估费用（可为0，如果不需要检查余额是否足够支付）
    );

    if (!balanceCheckResult.allowed) {
      // 余额不足或触发硬限制
      let errorMsg;
      if (balanceCheckResult.reason === "HARD_LIMIT_EXCEEDED") {
        errorMsg = `余额不足: ${balanceCheckResult.balance.toFixed(4)} <= ${balanceCheckResult.limit_value} (硬限额)`;
      } else if (balanceCheckResult.reason === "INSUFFICIENT_BALANCE") {
        errorMsg = `余额不足支付请求: ${balanceCheckResult.balance.toFixed(4)} < ${balanceCheckResult.required}`;
      } else {
        errorMsg = `余额检查失败: ${balanceCheckResult.reason}`;
      }

      const error = new Error(errorMsg);
      error.code = "INSUFFICIENT_BALANCE";
      error.context = {
        traceId,
        virtual_key,
        balance: balanceCheckResult.balance,
        reason: balanceCheckResult.reason,
        limit_type: balanceCheckResult.limit_type,
        limit_value: balanceCheckResult.limit_value,
        account_type: account.account_type,
      };
      throw error;
    }

    // 6. 检查通过，记录日志
    logger.debug("[BALANCE_CHECK] ✅ 余额检查通过", {
      traceId,
      virtual_key,
      balance: balanceCheckResult.balance?.toFixed(4),
      account_type: account.account_type,
      status: "OK",
    });

    // 7. 返回计费上下文，用于后续扣费
    return billingContext;
  } catch (error) {
    // 错误处理...
    if (error.code === "INSUFFICIENT_BALANCE") {
      throw error;
    }

    const wrappedError = new Error(`预算检查失败: ${error.message}`);
    wrappedError.originalError = error;
    throw wrappedError;
  }
}

async function chargeForUsageAfterRequest(
  virtual_key,
  portkeyResult,
  path,
  traceId,
) {
  const usage = portkeyResult?.usage ?? {};
  const provider = portkeyResult?.provider;
  const model = portkeyResult?.model;

  if (!provider || !model) {
    logger.warn("Portkey响应缺少provider或model信息，无法精确计费", {
      traceId,
      virtual_key,
      path,
      portkeyResult,
    });
    return null;
  }

  if (!usage.input_tokens && !usage.output_tokens && !usage.total_tokens) {
    logger.debug("无token用量，跳过计费", { virtual_key, path });
    return null;
  }

  try {
    logger.debug("开始扣费", { virtual_key, provider, model, usage });

    const result = await balanceService.chargeForUsage(
      virtual_key,
      provider,
      model,
      {
        input_tokens: usage.prompt_tokens || 0,
        output_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || 0,
      },
      traceId,
    );

    logger.info("扣费成功", {
      trace_id: traceId,
      virtual_key: virtual_key,
      cost: result.cost,
      currency: result.currency,
      new_balance: result.new_balance,
    });

    return result;
  } catch (error) {
    // ✅ 扣费失败是一个严重错误，需要记录并抛出
    logger.error("扣费失败", {
      trace_id: traceId,
      virtual_key,
      provider,
      model,
      path,
      error: error.message,
      stack: error.stack,
    });

    const billingError = new Error(`BILLING_FAILED: ${error.message}`);
    billingError.code = "BILLING_FAILED";
    billingError.originalError = error;
    throw billingError;
  }
}

async function checkRateLimits(userContext, requestBody, path, traceId) {
  const { virtual_key } = userContext;

  logger.debug("[RATE_LIMIT_CHECK] 开始限流检查", {
    traceId,
    virtual_key,
    path,
  });

  try {
    // 1. 获取账户信息确定身份
    const billingContext = await balanceService.getBillingContext(virtual_key);
    const account = billingContext.account;

    // 2. 构建用户信息
    const user = {
      tenant_id: account.account_type === "tenant" ? account.account_id : null,
      customer_type: account.customer_type_id,
      id: account.account_type === "user" ? account.account_id : null,
    };

    // 3. 提取provider和model
    const provider = requestBody.provider || "openai";
    const model = requestBody.model;

    // 4. 检查TPM（GatewayControlService的职责）
    const tpmResult = await GatewayControlService.checkTPM(
      user,
      provider,
      model,
      100, // 预估tokens
    );

    if (!tpmResult.allowed) {
      const error = new Error(
        `TPM限制超出: ${tpmResult.current}/${tpmResult.limit}`,
      );
      error.code = "RATE_LIMIT_EXCEEDED";
      throw error;
    }

    // 5. 检查RPM
    const rpmResult = await GatewayControlService.checkRPM(user, provider, 1);

    if (!rpmResult.allowed) {
      const error = new Error(
        `RPM限制超出: ${rpmResult.current}/${rpmResult.limit}`,
      );
      error.code = "RATE_LIMIT_EXCEEDED";
      throw error;
    }

    logger.debug("[RATE_LIMIT_CHECK] ✅ 限流检查通过", {
      traceId,
      virtual_key,
    });
  } catch (error) {
    if (error.code === "RATE_LIMIT_EXCEEDED") {
      throw error;
    }
    // 其他错误记录但允许继续
    logger.error("[RATE_LIMIT_CHECK] 检查出错", {
      traceId,
      virtual_key,
      error: error.message,
    });
  }
}

async function callPortkeyGateway(
  config,
  requestBody,
  userContext,
  path,
  traceId,
) {
  const { virtual_key } = userContext;
  const portkeyUrl = process.env.PORTKEY_GATEWAY_URL || "http://localhost:8787";
  const fullPath = path.startsWith("/v1/") ? path : `/v1${path}`;

  logger.debug("调用Portkey Gateway", {
    traceId,
    virtual_key,
    fullPath,
  });

  // 验证 Portkey 配置
  // const validation = portkeyConfigSchema.safeParse(config);
  // if (!validation.success) {
  //   const error = new Error(
  //     `无效的Portkey配置: ${validation.error.issues[0].message}`,
  //   );
  //   error.context = { validationErrors: validation.error.issues };
  //   throw error;
  // }

  try {
    const response = await fetch(`${portkeyUrl}${fullPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portkey-config": JSON.stringify(config),
        "x-portkey-trace-id": traceId, // ✅ 新增：传递给 Portkey Gateway
        "x-portkey-metadata": JSON.stringify({
          environment: process.env.NODE_ENV || "development",
          traceId: traceId,
        }),
      },
      body: JSON.stringify(requestBody),
      timeout: 30000, // 30秒超时
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error("Portkey Gateway响应错误", {
        traceId,
        virtual_key,
        status: response.status,
        error: JSON.parse(errorText),
      });

      const error = new Error(
        `Portkey Gateway error: ${response.status} ${response.statusText}`,
      );
      error.statusCode = response.status;
      throw error;
    }

    const result = await response.json();

    // 记录监控数据
    trackApiRequest(userContext, response, result, requestBody, path);
    let userResponse;

    // ✅ 扣费（失败会抛出异常）
    try {
      const chargeResult = await chargeForUsageAfterRequest(
        virtual_key,
        result,
        path,
        traceId,
      );
      if (chargeResult) {
        // 3. 过滤后返回给用户
        userResponse = {
          choices: result.choices,
          object: result.object,
          usage: result.usage,
          created: result.created,
          model: result.model,
          id: result.id,
          trace_id: traceId,
        };
        // result.billing = {
        //   charged: {
        //     cost: chargeResult.cost,
        //     currency: chargeResult.currency,
        //     new_balance: chargeResult.new_balance,
        //   },
        // };
      }
    } catch (billingError) {
      // 扣费失败，记录但不中断响应（可根据业务需求调整）
      logger.error("扣费失败但不中断响应", {
        trace_id: traceId,
        virtual_key: virtual_key,
        error: billingError.message,
      });
      // 可以选择不把billing错误传给客户端
    }
    // 返回请求给用户
    return userResponse;
  } catch (error) {
    // ✅ 网络或解析错误
    // logger.error("调用Portkey Gateway失败", {
    //   requestId,
    //   virtual_key,
    //   error: error.message,
    //   stack: error.stack,
    // });

    // error.message = `上游服务调用失败: ${error.message}`;
    throw error;
  }
}

function getFallbackConfig(userContext, requestBody) {
  // 确保有降级配置
  if (!process.env.FALLBACK_PROVIDER || !process.env.FALLBACK_API_KEY) {
    return null;
  }

  return {
    strategy: { mode: "single" },
    targets: [
      {
        provider: process.env.FALLBACK_PROVIDER,
        api_key: process.env.FALLBACK_API_KEY,
        override_params: {
          model: process.env.FALLBACK_MODEL || "gpt-3.5-turbo",
          max_tokens: 2000,
          temperature: 0.7,
        },
      },
    ],
  };
}

module.exports = router;
