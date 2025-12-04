// neuropia_api_gateway/src/routes/proxy.js
const { portkeyConfigSchema } = require("../validation/portkey_schema_config");
const { ConfigService } = require("../services/configService");
const { deductCost } = require("../services/billingService");
const BalanceService = require("../services/balanceService");
const express = require("express");
const router = express.Router();

const {
  trackApiRequest,
  trackError,
} = require("../services/monitoringService");

const MIN_REQUIRED_BALANCE = 0.0005; // 测试用最小余额

// 统一代理所有 /v1/* 请求到 Portkey Gateway
// neuropia_api_gateway/src/routes/proxy.js
router.all("/*", async (req, res) => {
  try {
    const { userContext } = req;
    const requestBody = req.body;
    const originalPath = req.path;

    // 1. 获取完整配置（数据库函数已包含所有virtual_key验证）
    let portkeyConfig;
    try {
      portkeyConfig = await ConfigService.getAllConfigs(
        userContext,
        requestBody,
      );
      //  2. 业务规则验证
      const metadata = portkeyConfig.metadata?._neuropia;
      if (metadata) {
        await validateBusinessRules(
          metadata,
          userContext,
          requestBody,
          originalPath,
        );
      }
    } catch (error) {
      // 服务宕机措施
      console.warn("配置获取失败，使用降级配置:", error.message);
      portkeyConfig = getFallbackConfig(userContext, requestBody);
    }

    // 3. 验证配置结构
    if (
      !portkeyConfig.targets ||
      !Array.isArray(portkeyConfig.targets) ||
      portkeyConfig.targets.length === 0
    ) {
      throw new Error("Invalid config: missing targets");
    }

    // 4. 调用 Portkey Gateway
    const portkeyResponse = await callPortkeyGateway(
      portkeyConfig,
      requestBody,
      userContext,
      originalPath,
    );

    res.json(portkeyResponse);
  } catch (error) {
    //  直接透传数据库错误
    if (error.message.includes("不在允许列表中")) {
      return res.status(403).json({
        error: error.message,
        code: "MODEL_NOT_ALLOWED",
      });
    }
    if (error.message.includes("频率超限")) {
      return res.status(429).json({
        error: error.message,
        code: "RATE_LIMIT_EXCEEDED",
      });
    }

    // 其他错误直接返回（包括数据库的virtual_key错误）
    res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

async function validateBusinessRules(metadata, userContext, requestBody, path) {
  const { sync_controls } = metadata;
  if (!sync_controls) return;

  const { model_access, rate_limits, budget } = sync_controls;

  // 1. 检查模型权限（针对聊天和补全端点）
  if (path.includes("/chat/completions") || path.includes("/completions")) {
    if (model_access?.allowed_models) {
      // 这里 allowed_models 一定是有内容的数组
      if (!model_access.allowed_models.includes(requestBody.model)) {
        throw new Error(`模型 ${requestBody.model} 不在允许列表中`);
      }
    }
  }

  if (budget) {
    // ✅ 获取上下文，后续扣费可以直接用
    const billingContext = await checkBudget(
      budget,
      userContext,
      requestBody,
      path,
    );
    // 可以把上下文存到请求中，后续扣费用
    userContext.billingContext = billingContext;
  }

  // 3. 限流检查（需要实现）
  if (rate_limits) {
    await checkRateLimits(rate_limits, userContext, requestBody, path);
  }
}

// 预算检查
async function checkBudget(budgetConfig, userContext, requestBody, path) {
  const virtual_key = userContext.virtual_key;

  // ✅ 使用新接口：getBillingContext
  const context = await BalanceService.getBillingContext(virtual_key);

  // ✅ 可选：校验上下文
  const validation = await BalanceService.validateBillingContext(context);
  if (!validation.valid) {
    console.error("计费上下文校验失败:", validation.issues);
    // 可以选择抛错或继续
  }

  const balance = Number(context.account.balance ?? 0);

  if (balance < MIN_REQUIRED_BALANCE) {
    const err = new Error(`余额不足（需要 >= ${MIN_REQUIRED_BALANCE}）`);
    err.code = "INSUFFICIENT_BALANCE";
    throw err;
  }

  // ✅ 返回上下文，后续扣费可以用
  return context;
}

// -------------------- 扣费逻辑 --------------------
async function chargeForUsageAfterRequest(virtual_key, portkeyResult, path) {
  const usage = portkeyResult?.usage ?? {};
  const provider = portkeyResult?.provider; // 需要确保Portkey返回provider
  const model = portkeyResult?.model; // 需要确保Portkey返回model

  if (!provider || !model) {
    console.warn("Portkey响应缺少provider或model信息，无法精确计费");
    return;
  }

  if (!usage.input_tokens && !usage.output_tokens && !usage.total_tokens) {
    console.log("无token用量，跳过计费");
    return;
  }

  try {
    // ✅ 使用新接口：chargeForUsage
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

    console.log(
      `💳 已扣费 ${result.cost.toFixed(4)} ${result.currency}, 新余额 = ${result.new_balance?.toFixed(4)}`,
    );

    return result;
  } catch (error) {
    console.error(
      `❌ 扣费失败: ${error.message}, ` +
        `virtual_key: ${virtual_key}, ` +
        `provider: ${provider}, model: ${model}, ` +
        `path: ${path}`,
    );

    // ✅ 扣费失败时中断请求
    throw new Error(`BILLING_FAILED: ${error.message}`);
  }
}

// 待实现的限流检查
async function checkRateLimits(rateLimits, userContext, requestBody, path) {
  // 后续实现 Redis 原子操作限流
  console.log("🚦 限流检查:", rateLimits);
}

async function callPortkeyGateway(config, requestBody, userContext, path) {
  const portkeyUrl = process.env.PORTKEY_GATEWAY_URL || "http://localhost:8787";

  // 确保路径包含 /v1 前缀
  const fullPath = path.startsWith("/v1/") ? path : `/v1${path}`;

  console.log("🔍 调用 Portkey Gateway 路径信息:", {
    originalPath: path,
    fullPath: fullPath,
    virtual_key: userContext.virtual_key,
  });

  // 验证 Portkey 配置
  const validation = portkeyConfigSchema.safeParse(config);
  if (!validation.success) {
    console.log("❌ Portkey 配置验证失败:");
    validation.error.issues.forEach((issue) => {
      console.log(`路径: ${issue.path.join(".")}`);
      console.log(`消息: ${issue.message}`);
    });
    throw new Error(
      `Invalid Portkey configuration: ${validation.error.issues[0].message}`,
    );
  }

  console.log("Portkey 配置验证成功");

  const response = await fetch(`${portkeyUrl}${fullPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portkey-config": JSON.stringify(config),
      "x-portkey-metadata": JSON.stringify({
        environment: process.env.NODE_ENV || "development",
      }),
    },
    body: JSON.stringify(requestBody),
  });

  console.log("Portkey Gateway 响应状态:", response.status);

  if (!response.ok) {
    const errorText = await response.text();

    await trackError({
      virtual_key: userContext.virtual_key,
      error: {
        status_code: response.status,
        message: errorText,
        trace_id: response.headers.get("x-portkey-trace-id"),
        provider: response.headers.get("x-portkey-provider"),
      },
      headers: Object.fromEntries(response.headers.entries()),
      timestamp: new Date().toISOString(),
    });

    console.error("Portkey Gateway 错误:", errorText);
    throw new Error(
      `Portkey Gateway error: ${response.status} ${response.statusText}`,
    );
  }

  const responseClone = response.clone();
  const result = await responseClone.json();

  // 确保传递正确的 path 参数
  console.log("记录监控数据，路径:", path);
  trackApiRequest(userContext, response, result, requestBody, path);
  // 扣费
  const chargeResult = await chargeForUsageAfterRequest(
    userContext.virtual_key,
    result,
    path,
  );
  // 可选：把扣费结果也返回给客户端（用于调试）
  result.billing = {
    charged: chargeResult
      ? {
          cost: chargeResult.cost,
          currency: chargeResult.currency,
          new_balance: chargeResult.new_balance,
        }
      : null,
  };

  return result;
}

function getFallbackConfig(userContext, requestBody) {
  console.warn("️使用降级配置");

  return {
    strategy: { mode: "single" },
    targets: [
      {
        provider: process.env.FALLBACK_PROVIDER,
        api_key: process.env.FALLBACK_API_KEY,
        override_params: {
          model: process.env.FALLBACK_MODEL,
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
