// ------------------------------
// Redis Key Schema
// ------------------------------

const REDIS_SCHEMA = {
  // --------------------------
  // Streams
  // --------------------------
  STREAMS: {
    USAGE_STREAM: "usage_stream",
    API_MONITORING_STREAM: "api_monitoring_stream",
    ERROR_STREAM: "error_stream",
    NETWORK_ERROR_STREAM: "network_error_stream",
    COST_ANALYSIS_STREAM: "cost_analysis_stream",
  },

  // --------------------------
  // Hashes
  // --------------------------
  HASHES: {
    VIRTUAL_KEY_USAGE: { pattern: "usage:{virtual_key}", ttl: 86400 },
    PROVIDER_STATS: { pattern: "provider_stats:{provider}", ttl: 2592000 },
    DAILY_STATS: { pattern: "stats:daily:{date}", ttl: 604800 },
    USER_COSTS: { pattern: "user_costs:{user_id}", ttl: 2592000 },
    ERROR_STATS: { pattern: "errors:{virtual_key}", ttl: 604800 },
  },

  // --------------------------
  // Sorted Sets
  // --------------------------
  SORTED_SETS: {
    VIRTUAL_KEY_RANKING: "ranking:virtual_keys",
    PROVIDER_RANKING: "ranking:providers",
    MODEL_RANKING: "ranking:models",
  },

  // --------------------------
  // Strings
  // --------------------------
  STRINGS: {
    PROVIDER_RATES: "provider_rates",
    RATE_LIMITS: "config:rate_limits",
    COST_CONFIG: "config:cost_rates",
  },

  // --------------------------
  // Helper to build keys
  // --------------------------
  buildKey: (pattern, params = {}) => {
    return pattern.replace(/\{(\w+)\}/g, (_, key) => {
      if (!(key in params)) {
        throw new Error(`Missing key param: ${key}`);
      }
      return params[key];
    });
  },
};

module.exports = REDIS_SCHEMA;
