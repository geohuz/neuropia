const z = require("zod");
const { portkeyConfigSchema } = require("./portkey_schema_config");

const schema = z.object({
  name: z.string(),
  age: z.number(),
});

console.log(z.toJSONSchema(schema));
const portkeySchema = z.toJSONSchema(portkeyConfigSchema);
console.log(JSON.stringify(portkeySchema, null, 2));
