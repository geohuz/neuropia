// neuropia_config_service/src/services/configManager.js
const postgrestClient = require('@shared/clients/postgrest');

class ConfigManager {
  static async loadAllConfigs() {
    try {
      // 修复：使用正确的 postgrest-js API
      const virtualKeys = await postgrestClient
        .from('virtual_key_details')
        .select('*')
        .eq('is_active', true);

      // 修复：处理响应格式
      for (const vk of virtualKeys.data) {
        await RedisService.cacheVirtualKey(vk.virtual_key, {
          user_id: vk.user_id,
          virtual_key_id: vk.id,
          rate_limits: {
            rpm: vk.rate_limit_rpm,
            tpm: vk.rate_limit_tpm,
          },
          allowed_models: vk.allowed_models || [],
          key_type_id: vk.key_type_id,
          key_prefix: vk.key_prefix,
        });
      }

      // 修复：使用正确的 API 获取配置
      const configs = await postgrestClient
        .from('active_portkey_configs')
        .select('*');

      for (const config of configs.data) {
        const cacheKey = `portkey_config:${config.id}`;
        await RedisService.cachePortkeyConfig(cacheKey, config.config_json);
      }

      console.log(
        `Loaded ${virtualKeys.data.length} virtual keys and ${configs.data.length} portkey configs`,
      );
    } catch (error) {
      console.error("Failed to load configurations:", error);
      throw error;
    }
  }

  static async getPortkeyConfigForUser(userId, tenantId) {
    try {
      // 修复：使用正确的 RPC 调用方式
      const response = await postgrestClient
        .rpc('get_active_portkey_config', {
          p_tenant_id: tenantId,
          p_user_id: userId,
        });

      return response.data;
    } catch (error) {
      console.error("Failed to get portkey config:", error);
      throw error;
    }
  }
}

module.exports = { ConfigManager };
