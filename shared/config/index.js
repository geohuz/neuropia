// 主配置出口
const streaming = require("./streaming");
// const billing = require('./billing');
// const redis = require('./redis');
// const database = require('./database');

module.exports = {
  streaming,
  // 环境判断
  isDevelopment: process.env.NODE_ENV === "development",
  isProduction: process.env.NODE_ENV === "production",
  isTest: process.env.NODE_ENV === "test",

  // 通用配置
  appName: process.env.APP_NAME || "neuropia-billing",
  logLevel: process.env.LOG_LEVEL || "info",
};
