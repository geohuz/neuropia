const fs = require("fs");
const { Client } = require("pg");

const providersJson = JSON.parse(fs.readFileSync("./providers.json", "utf-8"));
const modelsJson = JSON.parse(fs.readFileSync("./models.json", "utf-8"));

//const DEFAULT_PRICE = 0.01;
//const DEFAULT_CURRENCY = "usd";
const connectionString = `postgresql://geohuz@localhost:5432/neuropia`;
const client = new Client(connectionString);

const supportedProviders = new Set(providersJson.data.map((p) => p.id));

async function main() {
  await client.connect();
  console.log("🚀 Start importing provider_rate...");

  for (const m of modelsJson.data) {
    const provider = m.provider?.id;
    const model = m.id;
    if (!provider || !model || !supportedProviders.has(provider)) continue;

    await client.query(
      `INSERT INTO data.provider_rate(provider, model)
       VALUES ($1, $2)`,
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
