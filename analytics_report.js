// analytics_report.js
const axios = require("axios");

const BASE_URL = "http://localhost:3002";

// 获取监控流数据
async function getMonitoringStream(limit = 5) {
  try {
    console.log("\n📊 获取最近的 API 调用记录...");
    const response = await axios.get(
      `${BASE_URL}/monitoring/stream?limit=${limit}`,
    );
    const records = response.data.data;

    if (records && records.length > 0) {
      console.log(`✅ 找到 ${records.length} 条调用记录\n`);

      console.log("最近调用记录:");
      console.log("┌" + "─".repeat(80) + "┐");

      records.forEach((record, index) => {
        console.log(`│ 📝 记录 ${index + 1}`);
        console.log(`│   用户: ${record.virtual_key || "未知"}`);
        console.log(`│   路径: ${record.path || "未知"}`);
        console.log(`│   模型: ${record.model || "未知"}`);
        console.log(`│   服务商: ${record.provider_info?.provider || "未知"}`);
        console.log(
          `│   Token用量: ${record.usage?.total_tokens || 0} (输入:${record.usage?.prompt_tokens || 0}, 输出:${record.usage?.completion_tokens || 0})`,
        );
        console.log(
          `│   响应时间: ${record.performance?.total_response_time || 0}ms`,
        );
        console.log(
          `│   缓存: ${record.performance?.cache_status === "HIT" ? "✅ 命中" : "❌ 未命中"}`,
        );
        console.log(`│   时间: ${new Date(record.timestamp).toLocaleString()}`);

        if (index < records.length - 1) {
          console.log("├" + "─".repeat(80) + "┤");
        }
      });

      console.log("└" + "─".repeat(80) + "┘");
    } else {
      console.log("📭 暂无调用记录");
    }

    return records;
  } catch (error) {
    console.error("❌ 获取监控流失败:", error.message);
    if (error.response) {
      console.log(`   状态码: ${error.response.status}`);
    }
    return [];
  }
}

// 获取虚拟键统计
// 在报告脚本的 getAllVirtualKeyStats 函数中添加调试
async function getAllVirtualKeyStats() {
  try {
    console.log("\n📈 用户使用量排名...");
    const response = await axios.get(`${BASE_URL}/stats/top-keys?limit=10`);

    console.log("🔍 API响应状态:", response.status);
    console.log("🔍 API响应数据:", JSON.stringify(response.data, null, 2));

    const topKeys = response.data.data;

    if (topKeys && topKeys.length > 0) {
      console.log(`✅ 统计了 ${topKeys.length} 个用户\n`);

      topKeys.forEach((user, index) => {
        console.log(`${index + 1}. ${user.virtual_key.substring(0, 12)}...`);
        console.log(`   📞 请求数: ${user.request_count}`);
        console.log(`   💰 Token总量: ${user.total_tokens}`);
        console.log(`   ⏰ 最后使用: ${user.last_used}`);
        console.log("");
      });
    } else {
      console.log("📭 暂无用户使用数据");
      console.log("🔍 响应数据详情:", response.data);
    }

    return topKeys;
  } catch (error) {
    console.error("❌ 获取用户排名失败:", error.message);
    if (error.response) {
      console.log("🔍 错误响应:", error.response.data);
    }
    return [];
  }
}

// 获取提供商统计
async function getAllProviderStats() {
  try {
    console.log("\n🏢 AI 服务商性能报告...");
    const response = await axios.get(
      `${BASE_URL}/stats/top-providers?limit=10`,
    );
    const providers = response.data.data;

    if (providers && providers.length > 0) {
      console.log(`✅ 发现 ${providers.length} 个服务商\n`);
      console.log("📋 服务商性能汇总:\n");

      providers.forEach((provider, index) => {
        console.log(`${index + 1}. 🔧 ${provider.provider.toUpperCase()}`);
        console.log(`   📞 总请求数: ${provider.total_requests}`);
        console.log(`   💰 Token消耗: ${provider.total_tokens}`);
        console.log(`   ⚡ 缓存命中: ${provider.cache_hits} 次`);
        console.log(`   🔄 重试次数: ${provider.total_retries}`);
        console.log(`   📅 今日请求: ${provider.daily_requests}`);
        console.log(`   💸 今日Token: ${provider.daily_tokens}`);
        console.log("");
      });
    } else {
      console.log("📭 暂无服务商数据");
    }

    return providers;
  } catch (error) {
    console.error("❌ 获取服务商统计失败:", error.message);
    return [];
  }
}

// 获取缓存统计
async function getCacheStats() {
  try {
    console.log("\n💾 缓存性能分析...");
    const response = await axios.get(`${BASE_URL}/stats/cache`);
    const cacheStats = response.data.data;

    if (cacheStats) {
      console.log("📊 缓存效果报告:");
      console.log("┌" + "─".repeat(40) + "┐");
      console.log(
        `│ 总请求数     │ ${cacheStats.total_requests.toString().padEnd(8)} │`,
      );
      console.log(
        `│ 缓存命中     │ ${cacheStats.cache_hits.toString().padEnd(8)} │`,
      );
      console.log(
        `│ 缓存未命中   │ ${cacheStats.cache_misses.toString().padEnd(8)} │`,
      );
      console.log(`│ 命中率       │ ${cacheStats.hit_rate.padEnd(8)} │`);
      console.log("└" + "─".repeat(40) + "┘");

      if (cacheStats.hit_rate === "0%") {
        console.log("💡 建议: 缓存命中率较低，考虑优化缓存策略");
      } else if (parseFloat(cacheStats.hit_rate) > 50) {
        console.log("🎉 缓存效果良好！");
      }
    } else {
      console.log("📭 暂无缓存统计数据");
    }

    return cacheStats;
  } catch (error) {
    console.error("❌ 获取缓存统计失败:", error.message);
    return null;
  }
}

// 🔥 新增：错误统计测试
async function getErrorStats() {
  try {
    console.log("\n🔴 错误统计报告...");
    const response = await axios.get(`${BASE_URL}/stats/errors`);
    const errorStats = response.data.data;

    if (errorStats && Object.keys(errorStats).length > 0) {
      console.log(`📊 错误分布 (${Object.keys(errorStats).length} 个用户):`);
      console.log("┌" + "─".repeat(60) + "┐");

      Object.entries(errorStats).forEach(([virtualKey, errors], index) => {
        console.log(
          `│ 用户: ${virtualKey.substring(0, 15)}...`.padEnd(58) + "│",
        );
        Object.entries(errors).forEach(([statusCode, count]) => {
          console.log(`│   ${statusCode}: ${count} 次`.padEnd(58) + "│");
        });
        if (index < Object.keys(errorStats).length - 1) {
          console.log("├" + "─".repeat(60) + "┤");
        }
      });

      console.log("└" + "─".repeat(60) + "┘");

      // 计算总错误数
      const totalErrors = Object.values(errorStats).reduce(
        (total, userErrors) => {
          return (
            total +
            Object.values(userErrors).reduce((sum, count) => sum + count, 0)
          );
        },
        0,
      );
      console.log(`📈 总错误数: ${totalErrors}`);
    } else {
      console.log("✅ 暂无错误记录，系统运行正常");
    }

    return errorStats;
  } catch (error) {
    console.log("ℹ️  错误统计端点暂不可用:", error.message);
    return null;
  }
}

// 🔥 新增：性能指标测试
async function getPerformanceStats() {
  try {
    console.log("\n⚡ 性能指标分析...");

    // 从监控流数据计算性能指标
    const records = await getMonitoringStream(20);

    if (records && records.length > 0) {
      const validRecords = records.filter(
        (record) =>
          record.performance && record.performance.total_response_time > 0,
      );

      if (validRecords.length === 0) {
        console.log("ℹ️  暂无有效的性能数据（响应时间都为0）");
        return records;
      }

      const totalResponseTime = validRecords.reduce(
        (sum, record) => sum + (record.performance.total_response_time || 0),
        0,
      );
      const avgResponseTime = totalResponseTime / validRecords.length;

      // 计算分位数
      const responseTimes = validRecords
        .map((r) => r.performance.total_response_time)
        .sort((a, b) => a - b);

      const p95 = responseTimes[Math.floor(responseTimes.length * 0.95)];
      const p99 = responseTimes[Math.floor(responseTimes.length * 0.99)];

      console.log("📈 性能概览:");
      console.log("┌" + "─".repeat(50) + "┐");
      console.log(
        `│ 平均响应时间    │ ${avgResponseTime.toFixed(2)}ms`.padEnd(28) + "│",
      );
      console.log(`│ P95响应时间     │ ${p95.toFixed(2)}ms`.padEnd(28) + "│");
      console.log(`│ P99响应时间     │ ${p99.toFixed(2)}ms`.padEnd(28) + "│");
      console.log(
        `│ 有效样本数量    │ ${validRecords.length}`.padEnd(28) + "│",
      );
      console.log(`│ 总记录数量      │ ${records.length}`.padEnd(28) + "│");
      console.log("└" + "─".repeat(50) + "┘");

      // 性能建议
      if (avgResponseTime > 1000) {
        console.log("⚠️  性能警告: 平均响应时间超过1秒，建议优化");
      } else if (avgResponseTime > 500) {
        console.log("💡 性能提示: 响应时间偏长，可考虑优化");
      } else {
        console.log("✅ 性能状态: 良好");
      }
    } else {
      console.log("ℹ️  暂无性能数据可供分析");
    }

    return records;
  } catch (error) {
    console.error("❌ 性能分析失败:", error.message);
    return [];
  }
}

// 🔥 新增：成本分析测试
async function getCostAnalysis() {
  try {
    console.log("\n💰 成本分析报告...");
    const response = await axios.get(`${BASE_URL}/stats/costs`);
    const costStats = response.data.data;

    if (costStats && costStats.length > 0) {
      const totalCost = costStats.reduce(
        (sum, user) => sum + parseFloat(user.estimated_cost),
        0,
      );

      console.log("📊 用户成本排名:");
      console.log("┌" + "─".repeat(70) + "┐");
      console.log(
        `│ 排名 │ 用户ID         │ 请求数 │ Token总量 │ 预估成本(USD)  │`.padEnd(
          68,
        ) + "│",
      );
      console.log("├" + "─".repeat(70) + "┤");

      costStats.forEach((userCost, index) => {
        const rank = (index + 1).toString().padEnd(4);
        const user = userCost.virtual_key.substring(0, 12).padEnd(13);
        const requests = userCost.total_requests.toString().padEnd(6);
        const tokens = userCost.total_tokens.toString().padEnd(8);
        const cost = parseFloat(userCost.estimated_cost).toFixed(6).padEnd(12);
        console.log(
          `│ ${rank} │ ${user} │ ${requests} │ ${tokens} │ $${cost} │`,
        );
      });

      console.log("└" + "─".repeat(70) + "┘");
      console.log(`💰 总预估成本: $${totalCost.toFixed(6)} USD`);
    } else {
      console.log("ℹ️  暂无成本统计数据");
    }

    return costStats;
  } catch (error) {
    console.log("ℹ️  成本分析端点暂不可用:", error.message);
    return null;
  }
}

// 🔥 新增：健康状态检查
async function checkSystemHealth() {
  try {
    console.log("\n🏥 系统健康检查...");

    const endpoints = [
      "/monitoring/stream?limit=1",
      "/stats/top-keys?limit=1",
      "/stats/cache",
      "/stats/errors",
      "/stats/costs",
      "/stats/top-providers?limit=1",
    ];

    const healthResults = [];

    for (const endpoint of endpoints) {
      try {
        const startTime = Date.now();
        await axios.get(`${BASE_URL}${endpoint}`, { timeout: 5000 });
        const responseTime = Date.now() - startTime;
        healthResults.push({
          endpoint,
          status: "✅ 正常",
          responseTime: `${responseTime}ms`,
        });
      } catch (error) {
        healthResults.push({
          endpoint,
          status: "❌ 异常",
          error: error.message,
        });
      }
    }

    console.log("🔍 端点健康状态:");
    console.log("┌" + "─".repeat(80) + "┐");
    healthResults.forEach((result) => {
      const statusLine = `   ${result.endpoint}: ${result.status}`;
      if (result.responseTime) {
        console.log(
          `│ ${statusLine.padEnd(68)} ${result.responseTime.padEnd(8)}│`,
        );
      } else {
        console.log(`│ ${statusLine.padEnd(78)}│`);
      }
    });
    console.log("└" + "─".repeat(80) + "┘");

    const healthyEndpoints = healthResults.filter(
      (r) => r.status === "✅ 正常",
    ).length;
    const totalEndpoints = healthResults.length;

    console.log(`📊 健康度: ${healthyEndpoints}/${totalEndpoints} 个端点正常`);

    if (healthyEndpoints === totalEndpoints) {
      console.log("🎉 所有监控端点运行正常");
    } else if (healthyEndpoints >= totalEndpoints * 0.7) {
      console.log("⚠️  部分端点异常，但核心功能正常");
    } else {
      console.log("❌ 多个端点异常，建议检查系统状态");
    }

    return healthyEndpoints === totalEndpoints;
  } catch (error) {
    console.error("❌ 健康检查失败:", error.message);
    return false;
  }
}

// 更新主测试函数
async function runAllTests() {
  console.log("🚀 Neuropia AI 平台监控系统报告");
  console.log("=".repeat(60));
  console.log(`📡 数据源: ${BASE_URL}`);
  console.log(`⏰ 报告时间: ${new Date().toLocaleString()}`);
  console.log("=".repeat(60) + "\n");

  // 系统健康检查
  const isHealthy = await checkSystemHealth();

  if (!isHealthy) {
    console.log("\n⚠️  系统健康状态异常，继续生成报告但数据可能不完整...\n");
  }

  // 核心监控数据
  await getMonitoringStream(5);
  await getAllVirtualKeyStats();
  await getAllProviderStats();
  await getCacheStats();

  // 🔥 新增：深度分析
  await getErrorStats();
  await getPerformanceStats();
  await getCostAnalysis();

  console.log("\n" + "=".repeat(60));
  console.log("🎉 完整监控报告生成完成！");
  console.log("💡 提示: 所有数据实时更新，可随时重新运行查看最新状态");
  console.log("=".repeat(60));
}

// 直接运行
if (require.main === module) {
  runAllTests().catch(console.error);
}

module.exports = {
  getMonitoringStream,
  getAllVirtualKeyStats,
  getAllProviderStats,
  getCacheStats,
  getErrorStats,
  getPerformanceStats,
  getCostAnalysis,
  checkSystemHealth,
  runAllTests,
};
