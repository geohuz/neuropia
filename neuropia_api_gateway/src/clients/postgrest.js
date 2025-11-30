// neuropia_config_service/src/clients/postgrest.js
const { PostgrestClient } = require('@supabase/postgrest-js');

// 直接使用环境变量中的固定token
const postgrestToken = process.env.POSTGREST_TOKEN;

if (!postgrestToken) {
  throw new Error('POSTGREST_TOKEN environment variable is required');
}

// 直接导出配置好的客户端实例
module.exports = new PostgrestClient(
  process.env.POSTGREST_URL || 'http://localhost:3000',
  {
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${postgrestToken}`
    }
  }
);
