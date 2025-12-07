// utils/logger.js
const winston = require("winston");
const path = require("path");

const isProduction = process.env.NODE_ENV === "production";
const logLevel = process.env.LOG_LEVEL || (isProduction ? "info" : "debug");

const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp(), // 这里已经有了时间戳
    winston.format.errors({ stack: true }), // ✅ 自动捕获堆栈
    winston.format.json(), // ✅ 统一使用 JSON 格式，总是包含 timestamp
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(__dirname, "../../logs/error.log"),
      level: "error",
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(__dirname, "../../logs/combined.log"),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 10,
    }),
  ],
});

// 开发环境添加控制台（格式化输出）
if (!isProduction) {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          // 开发环境也显示时间戳
          let log = `${timestamp} [${level}] ${message}`;

          // 如果有 meta 数据，格式化输出
          if (Object.keys(meta).length > 0) {
            // 移除 winston 自动添加的 timestamp 和 level
            const { timestamp: _, level: __, ...restMeta } = meta;
            if (Object.keys(restMeta).length > 0) {
              log += ` ${JSON.stringify(restMeta, null, 2)}`;
            }
          }

          return log;
        }),
      ),
    }),
  );
}

module.exports = logger;
