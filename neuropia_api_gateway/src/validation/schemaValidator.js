// neuropia_api_gateway/src/validation/schemaValidator.js
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

// Schema 定义（直接嵌入，避免文件读取）
const NEUROPIA_METADATA_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Neuropia API Gateway Metadata",
  description: "API Gateway 高性能业务控制配置",
  type: "object",
  required: ["_neuropia"],
  additionalProperties: false,
  properties: {
    _neuropia: {
      type: "object",
      required: ["sync_controls"],
      additionalProperties: false,
      properties: {
        sync_controls: {
          type: "object",
          required: ["budget", "rate_limits"], // 🎯 移除 model_access 为必需
          additionalProperties: false,
          properties: {
            budget: {
              type: "object",
              required: ["balance"],
              additionalProperties: false,
              properties: {
                balance: {
                  type: "number",
                  minimum: 0,
                  description: "用户当前余额 - 唯一必需字段",
                },
                currency: {
                  type: "string",
                  enum: ["USD", "CNY"],
                  default: "USD",
                },
                min_balance: {
                  type: "number",
                  minimum: 0,
                  default: 0,
                },
              },
            },
            model_access: {
              type: "object",
              additionalProperties: false,
              properties: {
                allowed_models: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                  minItems: 1, // 🎯 如果有，必须至少1个元素
                  description: "可选的白名单，如果存在则必须为非空数组",
                },
                enable_streaming: {
                  type: "boolean",
                  default: true,
                },
              },
            },
            rate_limits: {
              type: "object",
              required: ["max_concurrent"],
              additionalProperties: false,
              properties: {
                max_concurrent: {
                  type: "integer",
                  minimum: 1,
                  maximum: 50,
                  default: 5,
                },
                cost_per_minute: {
                  type: "number",
                  minimum: 0,
                  default: 0,
                  description: "0表示不限制",
                },
              },
            },
          },
        },
        async_tracking: {
          type: "object",
          additionalProperties: false,
          properties: {
            enable_usage_tracking: {
              type: "boolean",
              default: true,
            },
          },
        },
      },
    },
  },
};

class SchemaValidator {
  constructor() {
    this.ajv = new Ajv({
      allErrors: true,
      strict: false,
      useDefaults: true, // 自动填充默认值
      removeAdditional: true, // 移除额外字段
      coerceTypes: true, // 自动类型转换
    });

    addFormats(this.ajv);

    // 编译验证函数
    this.validate = this.ajv.compile(NEUROPIA_METADATA_SCHEMA);

    console.log("✅ Schema validator initialized");
  }

  /**
   * 完整验证配置
   */
  validateComplete(config) {
    if (!config) {
      throw new Error("Configuration is required");
    }

    // 创建副本以避免修改原始对象
    const configCopy = JSON.parse(JSON.stringify(config));

    const isValid = this.validate(configCopy);

    if (!isValid) {
      const errors = this.validate.errors.map(
        (err) => `${err.instancePath || "root"} ${err.message}`,
      );
      throw new Error(`Schema validation failed: ${errors.join(", ")}`);
    }

    return configCopy;
  }

  /**
   * 快速验证 - 只检查必需字段
   */
  validateQuick(config) {
    if (!config) return false;
    if (!config._neuropia) return false;
    if (!config._neuropia.sync_controls) return false;

    const { budget, rate_limits } = config._neuropia.sync_controls;

    return (
      budget &&
      typeof budget.balance === "number" &&
      budget.balance >= 0 &&
      rate_limits &&
      typeof rate_limits.max_concurrent === "number" &&
      rate_limits.max_concurrent >= 1
    );
  }

  /**
   * 获取标准化配置（用于业务逻辑）
   */
  getStandardizedConfig(config) {
    const validated = this.validateComplete(config);

    return {
      budget: validated._neuropia.sync_controls.budget,
      model_access: validated._neuropia.sync_controls.model_access,
      rate_limits: validated._neuropia.sync_controls.rate_limits,
      async_tracking: validated._neuropia.async_tracking || {
        enable_usage_tracking: true,
      },
    };
  }

  /**
   * 生成默认配置
   */
  generateDefaultConfig() {
    return {
      // _neuropia: {
      //   sync_controls: {
      //     budget: {
      //       balance: 0,
      //       currency: 'USD',
      //       min_balance: 0
      //     },
      //     model_access: {
      //       allowed_models: [],
      //       enable_streaming: true
      //     },
      //     rate_limits: {
      //       max_concurrent: 5,
      //       cost_per_minute: 0
      //     }
      //   },
      //   async_tracking: {
      //     enable_usage_tracking: true
      //   }
      // }
    };
  }
}

// 创建单例实例
module.exports = new SchemaValidator();
