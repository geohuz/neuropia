// jest.config.js
module.exports = {
  setupFiles: ["./tests/setupEnv.js"],
  testEnvironment: "node",
  testTimeout: 30000,
  verbose: true,
  collectCoverageFrom: [
    "**/src/**/*.js",
    "!**/node_modules/**",
    "!**/src/app.js",
  ],
};
