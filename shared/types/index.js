// shared/types/index.js
/**
 * 平台通用类型定义
 */

// Virtual Key 配置类型
class VirtualKeyConfig {
  constructor(data) {
    this.id = data.id;
    this.user_id = data.user_id;
    this.virtual_key = data.virtual_key;
    this.name = data.name;
    this.description = data.description;
    this.rate_limit_rpm = data.rate_limit_rpm || 1000;
    this.rate_limit_tpm = data.rate_limit_tpm || 100000;
    this.allowed_models = data.allowed_models || [];
    this.is_active = data.is_active !== false;
    this.created_at = data.created_at;
    this.updated_at = data.updated_at;
    this.tenant_id = data.tenant_id;
  }
}

// 用户上下文类型
class UserContext {
  constructor(data) {
    this.user_id = data.user_id;
    this.username = data.username;
    this.tenant_id = data.tenant_id;
    this.tenant_name = data.tenant_name;
    this.status = data.status;
    this.balance = data.balance || 0;
    this.can_use_api = data.can_use_api || false;
    this.virtual_keys = data.virtual_keys || [];
    this.virtual_key = data.virtual_key; // 当前请求的 virtual key
    this.rate_limits = data.rate_limits || {
      rpm: 1000,
      tpm: 100000,
    };
  }
}

// Portkey 配置类型
class PortkeyConfig {
  constructor(data) {
    this.strategy = data.strategy || {
      mode: "fallback",
      on_status_codes: [429, 500, 502, 503],
    };
    this.targets = data.targets || [];
    this.cache = data.cache;
    this.retry = data.retry;
    this.metadata = data.metadata || {};
    this.before_request_hooks = data.before_request_hooks;
    this.after_request_hooks = data.after_request_hooks;
  }
}

// AI 使用记录类型
class UsageRecord {
  constructor(data) {
    this.user_id = data.user_id;
    this.provider = data.provider;
    this.model = data.model;
    this.input_tokens = data.input_tokens || 0;
    this.output_tokens = data.output_tokens || 0;
    this.cost = data.cost || 0;
    this.prompt_hash = data.prompt_hash;
    this.latency_ms = data.latency_ms;
    this.created_at = data.created_at || new Date().toISOString();
  }
}

// API 响应类型
class ApiResponse {
  constructor(success, data, error = null) {
    this.success = success;
    this.data = data;
    this.error = error;
    this.timestamp = new Date().toISOString();
  }

  static success(data) {
    return new ApiResponse(true, data);
  }

  static error(error, data = null) {
    return new ApiResponse(false, data, error);
  }
}

// 错误类型
class AppError extends Error {
  constructor(message, code, statusCode = 500) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message) {
    super(message, "VALIDATION_ERROR", 400);
  }
}

class AuthenticationError extends AppError {
  constructor(message) {
    super(message, "AUTHENTICATION_ERROR", 401);
  }
}

class AuthorizationError extends AppError {
  constructor(message) {
    super(message, "AUTHORIZATION_ERROR", 403);
  }
}

class ResourceNotFoundError extends AppError {
  constructor(message) {
    super(message, "RESOURCE_NOT_FOUND", 404);
  }
}

module.exports = {
  VirtualKeyConfig,
  UserContext,
  PortkeyConfig,
  UsageRecord,
  ApiResponse,
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  ResourceNotFoundError,
};
