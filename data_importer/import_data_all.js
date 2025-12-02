// insert_provider_rate.js
const fs = require("fs");
const { Client } = require("pg");

const modelsJson = JSON.parse(fs.readFileSync("./models.json", "utf-8"));
const DEFAULT_PRICE = 0.01; // 默认 price_per_token
const DEFAULT_CURRENCY = "usd";

const client = new Client({
  connectionString: `postgresql://geohuz@localhost:5432/neuropia`,
});

async function main() {
  await client.connect();
  console.log("🚀 Start importing provider_rate...");

  for (const m of modelsJson.data) {
    const provider = m.provider?.id;
    const model = m.id;
    const displayName = m.name ?? null;

    if (!provider || !model) {
      console.warn(`⚠ Skip invalid model: ${JSON.stringify(m)}`);
      continue;
    }

    await client.query(
      `
      INSERT INTO data.provider_rate(
        provider, model
      ) VALUES ($1, $2)
      `,
      [provider, model],
    );

    console.log(`✔ provider_rate inserted: ${provider} / ${model}`);
  }

  console.log("🎉 Done.");
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
