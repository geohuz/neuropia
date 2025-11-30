// tests/fixtures/testData.js
const { PostgrestClient } = require("@supabase/postgrest-js");
const postgrest = new PostgrestClient("http://localhost:3000");

const TestData = {
  sysAdmin: { email: "api@neuropia", pass: "api" },

  tenant: {
    name: "neuropia-test-tenant",
    contact: "test@neuropia.com",
    notes: "Test tenant for automated testing",
  },

  tenantAdmin: {
    email: "tenant-admin@neuropia.com",
    username: "tenantadmin",
    password: "testpass123",
  },

  // 租户内的普通用户 - 改名为 normalUser 以匹配函数参数
  normalUser: {
    // 从 tenantUser 改为 normalUser
    email: "tenant-user@neuropia.com",
    username: "tenantuser",
    password: "testpass123",
  },

  // 独立个人用户
  individualUser: {
    email: "individual-user@neuropia.com",
    username: "individualuser",
    password: "testpass123",
  },

  virtualKeyTypes: [
    {
      type_name: "default",
      description: "Default virtual key type",
      rate_limit_rpm: 1000,
      rate_limit_tpm: 100000,
      allowed_models: ["qwen-turbo", "gpt-3.5-turbo"],
    },
  ],

  async getAdminToken() {
    const { data, error } = await postgrest.rpc("login", this.sysAdmin);
    if (error) throw error;
    return data.token;
  },

  async initialize() {
    console.log("📦 Setting up test data...");

    const adminToken = await this.getAdminToken();
    const authClient = new PostgrestClient("http://localhost:3000", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    // 添加调试信息
    console.log("🔍 Calling setup_test_data with:", {
      p_tenant_data: this.tenant,
      p_tenant_admin_data: this.tenantAdmin,
      p_normal_user_data: this.normalUser, // 现在使用 normalUser
      p_virtual_key_types: this.virtualKeyTypes,
    });

    const { data, error } = await authClient.rpc("setup_test_data", {
      p_tenant_data: this.tenant,
      p_tenant_admin_data: this.tenantAdmin,
      p_normal_user_data: this.normalUser, // 确保这个字段存在
      p_virtual_key_types: this.virtualKeyTypes,
    });

    if (error) {
      console.error("❌ setup_test_data error:", error);
      throw error;
    }

    console.log("setupdata", data);
    this.tenant.id = data.tenant_id;
    this.tenantAdmin.id = data.tenant_admin_id;
    this.normalUser.id = data.normal_user_id;

    // 🚨 手动创建独立用户并获取ID
    const individualUserResult = await authClient.rpc("register_user", {
      p_email: this.individualUser.email,
      p_username: this.individualUser.username,
      p_password: this.individualUser.password,
      p_role: "norm_user",
      p_tenant_id: null,
    });

    this.individualUser.id = individualUserResult.data;
    console.log("✅ Individual user created with ID:", this.individualUser.id);

    console.log("✅ Test data setup complete");
    return this;
  },

  async cleanup() {
    console.log("🧹 Cleaning up test data...");

    const adminToken = await this.getAdminToken();
    const authClient = new PostgrestClient("http://localhost:3000", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const { error } = await authClient.rpc("cleanup_test_data");

    if (error) throw error;
    console.log("✅ Test data cleaned up");
  },
};

module.exports = TestData;
