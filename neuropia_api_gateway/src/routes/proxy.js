// neuropia_api_gateway/src/routes/proxy.js
const { portkeyConfigSchema } = require("../validation/portkey_schema_config");
const { ConfigService } = require("../services/configService");
const BalanceService = require("../services/balanceService");
const logger = require("@shared/utils/logger"); // 假设你创建了logger
const express = require("express");
const router = express.Router();

const {
  trackApiRequest,
  trackError,
} = require("../services/monitoringService");

const MIN_REQUIRED_BALANCE = 0.0005;

router.all("/*", async (req, res) => {
  const startTime = Date.now();
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  try {
    const { userContext } = req;
    const { virtual_key } = userContext;
    const requestBody = req.body;
    const originalPath = req.path;

    logger.info("开始代理请求", {
      requestId,
      virtual_key,
      path: originalPath,
      method: req.method,
    });

    // 1. 获取配置（失败直接抛出）
    let portkeyConfig;
    try {
      portkeyConfig = await ConfigService.getAllConfigs(
        userContext,
        requestBody,
      );
      logger.debug("配置获取成功", { requestId, virtual_key });
    } catch (configError) {
      logger.error("配置获取失败，尝试降级配置", {
        requestId,
        virtual_key,
        error: configError.message,
      });

      // ✅ 降级配置是备选方案，不是默认
      portkeyConfig = getFallbackConfig(userContext, requestBody);
      if (!portkeyConfig) {
        throw new Error(`配置服务不可用且无降级配置: ${configError.message}`);
      }
      logger.warn("使用降级配置", { requestId, virtual_key });
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
    const metadata = portkeyConfig.metadata?._neuropia;
    if (metadata) {
      try {
        await validateBusinessRules(
          metadata,
          userContext,
          requestBody,
          originalPath,
        );
      } catch (validationError) {
        // 业务规则验证失败直接返回给客户端
        logger.warn("业务规则验证失败", {
          requestId,
          virtual_key,
          error: validationError.message,
        });
        throw validationError; // 继续向上抛，让上层处理HTTP响应
      }
    }

    // 4. 调用 Portkey Gateway
    const portkeyResponse = await callPortkeyGateway(
      portkeyConfig,
      requestBody,
      userContext,
      originalPath,
      requestId,
    );

    const duration = Date.now() - startTime;
    logger.info("请求处理完成", {
      requestId,
      virtual_key,
      duration,
      status: "success",
    });

    res.json(portkeyResponse);
  } catch (error) {
    const duration = Date.now() - startTime;

    // ✅ 记录完整错误信息（堆栈+上下文）
    logger.error("代理请求失败", {
      requestId,
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
        error: error.message,
        code: "MODEL_NOT_ALLOWED",
        request_id: requestId,
      });
    }

    if (
      error.code === "INSUFFICIENT_BALANCE" ||
      error.message.includes("余额不足")
    ) {
      return res.status(402).json({
        // 402 Payment Required
        error: error.message,
        code: "INSUFFICIENT_BALANCE",
        request_id: requestId,
      });
    }

    if (
      error.code === "RATE_LIMIT_EXCEEDED" ||
      error.message.includes("频率超限")
    ) {
      return res.status(429).json({
        error: error.message,
        code: "RATE_LIMIT_EXCEEDED",
        request_id: requestId,
      });
    }

    if (error.message.includes("BILLING_FAILED")) {
      return res.status(500).json({
        error: "计费系统错误",
        code: "BILLING_FAILED",
        request_id: requestId,
      });
    }

    // 其他错误
    res.status(500).json({
      error: "内部服务器错误",
      code: "INTERNAL_ERROR",
      request_id: requestId,
      // 生产环境不返回详情，开发环境可以
      details:
        process.env.NODE_ENV === "production" ? undefined : error.message,
    });
  }
});

async function validateBusinessRules(metadata, userContext, requestBody, path) {
  const { sync_controls } = metadata;
  if (!sync_controls) return;

  const { model_access, rate_limits, budget } = sync_controls;

  // 1. 检查模型权限
  if (path.includes("/chat/completions") || path.includes("/completions")) {
    if (model_access?.allowed_models) {
      const model = requestBody.model;
      if (!model) {
        throw new Error("请求缺少model参数");
      }

      if (!model_access.allowed_models.includes(model)) {
        const error = new Error(`模型 ${model} 不在允许列表中`);
        error.code = "MODEL_NOT_ALLOWED";
        throw error;
      }
    }
  }

  // 2. 预算检查
  if (budget) {
    try {
      const billingContext = await checkBudget(
        budget,
        userContext,
        requestBody,
        path,
      );
      userContext.billingContext = billingContext;
    } catch (budgetError) {
      // 预算检查失败，直接抛出
      throw budgetError;
    }
  }

  // 3. 限流检查
  if (rate_limits) {
    try {
      await checkRateLimits(rate_limits, userContext, requestBody, path);
    } catch (rateLimitError) {
      rateLimitError.code = "RATE_LIMIT_EXCEEDED";
      throw rateLimitError;
    }
  }
}

async function checkBudget(budgetConfig, userContext, requestBody, path) {
  const { virtual_key } = userContext;

  logger.debug("开始预算检查", { virtual_key, path });

  try {
    // ✅ 这里直接让错误自然抛出
    const context = await BalanceService.getBillingContext(virtual_key);

    const balance = Number(context.account.balance ?? 0);
    logger.debug("账户余额", { virtual_key, balance });

    if (balance < MIN_REQUIRED_BALANCE) {
      const error = new Error(`余额不足（需要 >= ${MIN_REQUIRED_BALANCE}）`);
      error.code = "INSUFFICIENT_BALANCE";
      error.context = {
        virtual_key,
        balance,
        required: MIN_REQUIRED_BALANCE,
      };
      throw error;
    }

    return context;
  } catch (error) {
    // ✅ 在原始错误上添加更多上下文
    error.message = `预算检查失败 [${virtual_key}]: ${error.message}`;
    throw error;
  }
}

async function chargeForUsageAfterRequest(virtual_key, portkeyResult, path) {
  const usage = portkeyResult?.usage ?? {};
  const provider = portkeyResult?.provider;
  const model = portkeyResult?.model;

  if (!provider || !model) {
    logger.warn("Portkey响应缺少provider或model信息，无法精确计费", {
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

    const result = await BalanceService.chargeForUsage(
      virtual_key,
      provider,
      model,
      {
        input_tokens: usage.prompt_tokens || 0,
        output_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || 0,
      },
    );

    logger.info("扣费成功", {
      virtual_key,
      cost: result.cost,
      currency: result.currency,
      new_balance: result.new_balance,
    });

    return result;
  } catch (error) {
    // ✅ 扣费失败是一个严重错误，需要记录并抛出
    logger.error("扣费失败", {
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

async function checkRateLimits(rateLimits, userContext, requestBody, path) {
  // 实现限流逻辑...
  // logger.debug("限流检查", {
  //   virtual_key: userContext.virtual_key,
  //   path,
  //   rateLimits
  // });
  // throw new Error("频率超限"); // 测试用
}

async function callPortkeyGateway(
  config,
  requestBody,
  userContext,
  path,
  requestId,
) {
  const { virtual_key } = userContext;
  const portkeyUrl = process.env.PORTKEY_GATEWAY_URL || "http://localhost:8787";
  const fullPath = path.startsWith("/v1/") ? path : `/v1${path}`;

  logger.debug("调用Portkey Gateway", {
    requestId,
    virtual_key,
    fullPath,
  });

  // 验证 Portkey 配置
  const validation = portkeyConfigSchema.safeParse(config);
  if (!validation.success) {
    const error = new Error(
      `无效的Portkey配置: ${validation.error.issues[0].message}`,
    );
    error.context = { validationErrors: validation.error.issues };
    throw error;
  }

  try {
    const response = await fetch(`${portkeyUrl}${fullPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portkey-config": JSON.stringify(config),
        "x-portkey-metadata": JSON.stringify({
          environment: process.env.NODE_ENV || "development",
          request_id: requestId,
        }),
      },
      body: JSON.stringify(requestBody),
      timeout: 30000, // 30秒超时
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error("Portkey Gateway响应错误", {
        requestId,
        virtual_key,
        status: response.status,
        error: errorText,
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

    // ✅ 扣费（失败会抛出异常）
    try {
      const chargeResult = await chargeForUsageAfterRequest(
        virtual_key,
        result,
        path,
      );
      if (chargeResult) {
        result.billing = {
          charged: {
            cost: chargeResult.cost,
            currency: chargeResult.currency,
            new_balance: chargeResult.new_balance,
          },
        };
      }
    } catch (billingError) {
      // 扣费失败，记录但不中断响应（可根据业务需求调整）
      logger.error("扣费失败但不中断响应", {
        requestId,
        virtual_key,
        error: billingError.message,
      });
      // 可以选择不把billing错误传给客户端
    }

    return result;
  } catch (error) {
    // ✅ 网络或解析错误
    logger.error("调用Portkey Gateway失败", {
      requestId,
      virtual_key,
      error: error.message,
      stack: error.stack,
    });

    error.message = `上游服务调用失败: ${error.message}`;
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
    metadata: {
      _neuropia: {
        sync_controls: {
          budget: { balance: 0 },
          model_access: { allowed_models: [] },
          rate_limits: { max_concurrent: 1 },
        },
      },
    },
  };
}

module.exports = router;
