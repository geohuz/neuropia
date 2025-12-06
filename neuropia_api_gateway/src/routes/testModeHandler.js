// handlers/testModeHandler.js
const logger = require("@shared/utils/logger");
const balanceService = require("../services/balanceService");

/**
 * 统一处理测试模式请求
 */
async function handleTestMode(req, res, context) {
  const { requestId, userContext, requestBody, startTime } = context;

  const { virtual_key } = userContext;

  try {
    logger.debug("开始测试模式处理", {
      requestId,
      virtual_key,
    });

    // 1. 模拟AI响应
    const mockResponse = await mockPortkeyGateway(requestBody);
    const duration = Date.now() - startTime;

    // 2. 真实扣费（因为跳过了proxy.js的扣费逻辑）
    logger.debug("测试模式扣费", {
      requestId,
      model: mockResponse.model,
      provider: mockResponse.provider,
      usage: mockResponse.usage,
    });

    const chargeResult = await balanceService.chargeForUsage(
      virtual_key,
      mockResponse.provider,
      mockResponse.model,
      mockResponse.usage,
    );

    // 3. 添加billing信息（与proxy.js保持一致）
    mockResponse.billing = {
      charged: {
        cost: chargeResult.cost,
        currency: chargeResult.currency,
        new_balance: chargeResult.new_balance,
      },
    };

    // 4. 返回响应
    res.json(mockResponse);

    logger.info("测试模式请求处理完成", {
      requestId,
      duration,
      virtual_key,
    });
  } catch (error) {
    logger.error("测试模式请求失败", {
      requestId,
      virtual_key,
      error: error.message,
      stack: error.stack,
    });

    const duration = Date.now() - startTime;

    // 返回错误响应
    res.status(500).json({
      error: {
        message: error.message,
        code: "TEST_MODE_ERROR",
        request_id: requestId,
      },
    });

    logger.info("测试模式请求失败完成", {
      requestId,
      duration,
      virtual_key,
    });
  }
}

/**
 * 模拟Portkey Gateway响应
 */
async function mockPortkeyGateway(requestBody) {
  // 使用固定的token数（与真实AI响应保持一致）
  const usage = {
    prompt_tokens: 18, // 可能chargeForUsage需要input_tokens
    completion_tokens: 39, // 可能chargeForUsage需要output_tokens
    total_tokens: 57,
    input_tokens: 18, // 添加这些字段
    output_tokens: 39,
  };

  // 使用请求中的 model 和 provider，或默认值
  const model = requestBody.model || "qwen-turbo";
  const provider = requestBody.provider || "dashscope";

  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    provider: provider,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "这是模拟的AI回复。本次请求使用测试模式。",
        },
        finish_reason: "stop",
      },
    ],
    usage: usage,
    _test_mode: true, // 标记为测试响应
  };
}

/**
 * 检查是否为测试请求
 */
function isTestRequest(virtualKey) {
  return virtualKey && virtualKey.startsWith("test_vk_");
}

/**
 * 获取原始virtual key（去除test_vk_前缀）
 */
function getOriginalVirtualKey(virtualKey) {
  return virtualKey.replace("test_vk_", "");
}

module.exports = {
  handleTestMode,
  mockPortkeyGateway,
  isTestRequest,
  getOriginalVirtualKey,
};
