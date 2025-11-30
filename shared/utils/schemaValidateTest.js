const { configSchema } = require("./portkey_schema_config");

const data = {
  strategy: { mode: "single" },
  model: "openai",
  retry: {
    attempts: 3,
    on_status_codes: [429, 502],
  },
  request_timeout: 30000,
};

// 验证配置
const result = configSchema.safeParse(data);

if (!result.success) {
  // 获取详细错误信息
  console.log("验证失败:");
  result.error.issues.forEach((issue) => {
    console.log(`路径: ${issue.path.join(".")}`);
    console.log(`消息: ${issue.message}`);
    console.log("---");
  });
} else {
  console.log("验证成功:", result.data);
}
