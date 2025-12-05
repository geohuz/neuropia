// utils/logger.js
const winston = require('winston');
const path = require('path');

const isProduction = process.env.NODE_ENV === 'production';
const logLevel = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');

const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }), // ✅ 自动捕获堆栈
    isProduction 
      ? winston.format.json() // 生产：JSON
      : winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
          // 开发：易读格式
          let log = `${timestamp} [${level}] ${message}`;
          if (stack) log += `\n${stack}`; // ✅ 堆栈单独显示
          if (Object.keys(meta).length) log += ` ${JSON.stringify(meta, null, 2)}`;
          return log;
        })
  ),
  transports: [
    // 生产：文件 + 控制台（简化）
    new winston.transports.File({ 
      filename: path.join(__dirname, '../../logs/error.log'), 
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5
    }),
    new winston.transports.File({ 
      filename: path.join(__dirname, '../../logs/combined.log'),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 10
    }),
  ]
});

// 开发环境添加控制台（彩色）
if (!isProduction) {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

module.exports = logger;