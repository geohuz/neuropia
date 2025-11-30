// neuropia_api_gateway/src/validation/simpleTest.js
const schemaValidator = require('./schemaValidator');

// 完整的 Portkey 配置，我们只验证 metadata 部分
const portkeyConfig = {
  strategy: { mode: "single" },
  model: "openai",
  retry: {
    attempts: 3,
    on_status_codes: [429, 502],
  },
  request_timeout: 30000,
  metadata: {  // 🎯 这是我们真正要验证的部分
    _neuropia: {
      sync_controls: {
        budget: {
          balance: 100.0
        },
        model_access: {
          allowed_models: ["gpt-4"]
        },
        rate_limits: {
          max_concurrent: 5
        }
      }
    }
  }
};

console.log('🧪 Testing metadata validation...\n');

// 提取 metadata 进行验证
const metadata = portkeyConfig.metadata;

try {
  const result = schemaValidator.validateComplete(metadata);
  console.log("✅ 验证成功");
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.log("❌ 验证失败:");
  console.log(error.message);
}

// 快速验证
console.log('\n快速验证:', schemaValidator.validateQuick(metadata) ? '✅ 通过' : '❌ 失败');
