const Ajv = require("ajv");
const ajv = new Ajv({ strict: false }); // 👈 允许非标准字段

const schema = JSON.parse(`
{"type":"object","properties":{"strategy":{"type":"object","properties":{"mode":{"type":"string"},"on_status_codes":{"type":"array","items":{"type":"number"}},"conditions":{"type":"array","items":{"type":"object","properties":{"query":{"type":"object","properties":{},"additionalProperties":false},"then":{"type":"string"}},"required":["query","then"],"additionalProperties":false}},"default":{"type":"string"}},"required":["mode"],"additionalProperties":false},"provider":{"type":"string"},"api_key":{"type":"string"},"aws_secret_access_key":{"type":"string"},"aws_access_key_id":{"type":"string"},"aws_session_token":{"type":"string"},"aws_region":{"type":"string"},"cache":{"type":"object","properties":{"mode":{"type":"string"},"max_age":{"type":"number"}},"required":["mode"],"additionalProperties":false},"retry":{"type":"object","properties":{"attempts":{"type":"number"},"on_status_codes":{"type":"array","items":{"type":"number"}},"use_retry_after_header":{"type":"boolean"}},"required":["attempts"],"additionalProperties":false},"weight":{"type":"number"},"on_status_codes":{"type":"array","items":{"type":"number"}},"targets":{"type":"array","items":{"$ref":"#"}},"request_timeout":{"type":"number"},"custom_host":{"type":"string"},"forward_headers":{"type":"array","items":{"type":"string"}},"vertex_project_id":{"type":"string"},"vertex_region":{"type":"string"},"after_request_hooks":{"type":"array","items":{"type":"object","properties":{},"additionalProperties":{}}},"before_request_hooks":{"type":"array","items":{"type":"object","properties":{},"additionalProperties":{}}},"input_guardrails":{"anyOf":[{"type":"array","items":{"type":"string"}},{"type":"array","items":{"type":"object","properties":{},"additionalProperties":{}}}]},"output_guardrails":{"anyOf":[{"type":"array","items":{"type":"string"}},{"type":"array","items":{"type":"object","properties":{},"additionalProperties":{}}}]},"vertex_service_account_json":{"type":"object","properties":{},"additionalProperties":{"type":"string"}},"openai_project":{"type":"string"},"openai_organization":{"type":"string"},"azure_model_name":{"type":"string"},"azure_auth_mode":{"type":"string"},"strict_open_ai_compliance":{"type":"boolean"}},"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}
`);

const validate = ajv.compile(schema);

// 你的实际配置对象
const data = {
  retry: {
    attempts: 3,
    on_status_codes: [429, 502],
  },
  request_timeout: 30000,
};

const valid = validate(data);

if (!valid) {
  console.error("❌ 校验失败:", validate.errors);
} else {
  console.log("✅ 配置通过校验！");
}
