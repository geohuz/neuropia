// shared/utils/logger.js
class Logger {
  static info(message, meta = {}) {
    this.log("info", message, meta);
  }

  static error(message, meta = {}) {
    this.log("error", message, meta);
  }

  static warn(message, meta = {}) {
    this.log("warn", message, meta);
  }

  static debug(message, meta = {}) {
    if (process.env.NODE_ENV === "development") {
      this.log("debug", message, meta);
    }
  }

  static log(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level: level.toUpperCase(),
      service: process.env.SERVICE_NAME || "unknown",
      environment: process.env.NODE_ENV || "development",
      message,
      ...meta,
    };

    const logString = JSON.stringify(logEntry);

    switch (level) {
      case "error":
        console.error(logString);
        break;
      case "warn":
        console.warn(logString);
        break;
      case "info":
        console.info(logString);
        break;
      default:
        console.log(logString);
    }
  }

  // 请求日志中间件
  static requestLogger() {
    return (req, res, next) => {
      const startTime = Date.now();

      res.on("finish", () => {
        const duration = Date.now() - startTime;
        Logger.info("HTTP Request", {
          method: req.method,
          url: req.url,
          status: res.statusCode,
          duration: `${duration}ms`,
          user_agent: req.get("User-Agent"),
          ip: req.ip,
          virtual_key: req.get("x-virtual-key"),
        });
      });

      next();
    };
  }

  // 错误日志中间件
  static errorLogger() {
    return (err, req, res, next) => {
      Logger.error("Unhandled Error", {
        error: err.message,
        stack: err.stack,
        method: req.method,
        url: req.url,
        virtual_key: req.get("x-virtual-key"),
      });
      next(err);
    };
  }
}

module.exports = Logger;
