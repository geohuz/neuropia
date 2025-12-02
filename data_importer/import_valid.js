// insert_provider_rate.js
const fs = require("fs");
const { Client } = require("pg");

const connectionStr = `postgresql://geohuz@localhost:5432/neuropia`;
const client = new Client(connectionStr);

async function main() {
  try {
    await client.connect();
    console.log("Connected to PostgreSQL database");

    // 读取 providers.json 和 models.json
    console.log("Reading providers.json...");
    const providersData = JSON.parse(
      fs.readFileSync("./providers.json", "utf-8"),
    );

    console.log("Reading models.json...");
    const modelsData = JSON.parse(fs.readFileSync("./models.json", "utf-8"));

    // 从 providers.json 获取所有 provider id（小写）
    const validProviders = providersData.data.map((p) => p.id.toLowerCase());
    console.log(
      `\nTotal providers from providers.json: ${validProviders.length}`,
    );

    // 统计数据
    let totalInserted = 0;
    let providersWithModels = 0;
    let providersWithoutModels = 0;

    for (const providerId of validProviders) {
      try {
        // 过滤 models.json 中对应 provider 的 models
        const models = modelsData.data.filter(
          (m) => m.provider.id === providerId,
        );

        if (models.length > 0) {
          providersWithModels++;
          console.log(`\n[${providerId}] Found ${models.length} models`);

          // 插入每个 model
          for (const model of models) {
            const modelId = model.id.toLowerCase();

            const result = await client.query(
              `
              INSERT INTO data.provider_rate(provider, model)
              VALUES($1, $2)`,
              [providerId, modelId],
            );

            if (result.rowCount > 0) {
              console.log(`  ✓ Inserted: ${modelId}`);
              totalInserted++;
            } else {
              console.log(`  - Already exists: ${modelId}`);
            }
          }
        } else {
          providersWithoutModels++;
          console.log(
            `\n[${providerId}] No models found, inserting empty model`,
          );

          const result = await client.query(
            `
            INSERT INTO data.provider_rate(provider, model)
            VALUES($1, $2)`,
            [providerId, ""],
          );

          if (result.rowCount > 0) {
            console.log(`  ✓ Inserted empty model for ${providerId}`);
            totalInserted++;
          } else {
            console.log(`  - Provider ${providerId} already exists`);
          }
        }
      } catch (err) {
        console.error(
          `\n[ERROR] Processing provider ${providerId}:`,
          err.message,
        );
      }
    }

    // 输出统计信息
    console.log("\n" + "=".repeat(50));
    console.log("INSERTION COMPLETE");
    console.log("=".repeat(50));
    console.log(`Total providers processed: ${validProviders.length}`);
    console.log(`Providers with models: ${providersWithModels}`);
    console.log(`Providers without models: ${providersWithoutModels}`);
    console.log(`Total records inserted/checked: ${totalInserted}`);
  } catch (err) {
    console.error("Error in main process:", err);
  } finally {
    await client.end();
    console.log("\nDatabase connection closed");
  }
}

main().catch(console.error);
