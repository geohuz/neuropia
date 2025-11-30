// neuropia_config_service/src/app.js
const express = require("express");
const pgListener = require("./listeners/pgListener");
const { PortkeyConfigGenerator } = require("./services/portkeyConfigGenerator");
const RedisService = require("@shared/clients/redis")

class ConfigServiceApp {
  constructor() {
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    this.app.use(express.json());

    // CORS
    this.app.use((req, res, next) => {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  console.log('📦 请求头:', req.headers);
  console.log('📝 请求体:', JSON.stringify(req.body, null, 2)); // 🎯 添加请求体日志
      res.header("Access-Control-Allow-Origin", "*");
      res.header(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept, Authorization",
      );
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
      );
      next();
    });

    // 请求日志
    this.app.use((req, res, next) => {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
      next();
    });
  }

  setupRoutes() {
    // 健康检查
    this.app.get("/health", (req, res) => {
      res.json({
        status: "healthy",
        service: "config-service",
        timestamp: new Date().toISOString(),
      });
    });

    // 🎯 生成 Portkey 配置
    this.app.post("/generate-config", this.handleGenerateConfig.bind(this));

    // 🎯 清理缓存
    this.app.post("/clear-cache", this.handleClearCache.bind(this));

    // 🎯 删除废弃的路由：/reload-configs 和 /preload-cache
  }

  /**
   * 生成 Portkey 配置
   */

async handleGenerateConfig(req, res) {
    try {
        const { userContext, virtualKeyConfig, requestBody } = req.body;

        if (!userContext?.user_id || !userContext?.virtual_key) {
            return res.status(400).json({
                success: false,
                error: "Missing required user context",
            });
        }

        // 🎯 修改：不再强制要求 requestBody.model
        // 如果没有提供 model，系统会根据配置自动选择

        console.log("🎯 Generating config for:", {
            user_id: userContext.user_id,
            virtual_key: userContext.virtual_key,
            model: requestBody?.model || 'auto-select'  // 🎯 标记为自动选择
        });

        const portkeyConfig = await PortkeyConfigGenerator.generateConfig(
            userContext,
            virtualKeyConfig || {},
            requestBody || {},  // 🎯 确保 requestBody 不为 undefined
        );

        res.json({
            success: true,
            config: portkeyConfig,
            generated_at: new Date().toISOString(),
        });
    } catch (error) {
        console.error("❌ Generate config error:", error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
}

  /**
   * 清理缓存
   */
  async handleClearCache(req, res) {
    try {
      const { virtual_key, tier_name } = req.body;

      if (virtual_key) {
        const pattern = `portkey_config:*:${virtual_key}:*`;
        const keys = await RedisService.keys(pattern);
        if (keys.length > 0) {
          await RedisService.del(...keys);
        }
        console.log(`🧹 Cleared caches for virtual_key: ${virtual_key}`);
      } else if (tier_name) {
        const pattern = `portkey_config:*:*:${tier_name}:*`;
        const keys = await RedisService.keys(pattern);
        if (keys.length > 0) {
          await RedisService.del(...keys);
        }
        console.log(`🍰 Cleared caches for tier: ${tier_name}`);
      } else {
        await this.clearAllCache();
      }

      res.json({
        success: true,
        message: "Cache cleared successfully",
      });
    } catch (error) {
      console.error("❌ Clear cache error:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * 清理所有缓存
   */
  async clearAllCache() {
    const portkeyKeys = await RedisService.keys("portkey_config:*");
    const configResolutionKeys = await RedisService.keys("config_resolution:*");
    const allKeys = [...portkeyKeys, ...configResolutionKeys];

    if (allKeys.length > 0) {
      await RedisService.del(...allKeys);
      console.log(`🌍 Cleared all ${allKeys.length} caches`);
    }
  }

  /**
   * 启动服务
   */
  async start(port = 3001) {
    try {
      // 🎯 先连接 Redis
      await RedisService.connect();

      // 连接监听器
      await pgListener.connect();

      this.server = this.app.listen(port, () => {
        console.log(`🎯 Config Service running on port ${port}`);
        console.log(`📊 Endpoints:`);
        console.log(`   POST /generate-config`);
        console.log(`   POST /clear-cache`);
        console.log(`📢 Listening to PostgreSQL channels: config_updates`);
      });
    } catch (error) {
      console.error("❌ Failed to start Config Service:", error);
      throw error;
    }
  }

  async stop() {
    if (this.server) {
      this.server.close();
      await pgListener.disconnect();
      console.log("Config Service stopped");
    }
  }
}

module.exports = ConfigServiceApp;
