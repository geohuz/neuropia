// tests/startup.test.js
const startApiGateway = require("../neuropia_api_gateway/src/server");
const startConfigService = require("../neuropia_config_service/src/server");

describe("Service Startup", () => {
  test("should export start functions", () => {
    expect(typeof startApiGateway).toBe("function");
    expect(typeof startConfigService).toBe("function");
  });
});
