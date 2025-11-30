// scripts/debug-analytics-performance.js
const AnalyticsService = require('./src/services/analyticsService');
const RedisService = require('./src/clients/redis');

async function debugPerformance() {
    console.log('🔍 分析 AnalyticsService 性能...\n');

    try {
        // 测试监控流
        console.log('1. 测试 getMonitoringStream...');
        const start1 = Date.now();
        const records = await AnalyticsService.getMonitoringStream('api_monitoring_stream', 5);
        const time1 = Date.now() - start1;
        console.log(`   时间: ${time1}ms, 记录数: ${records.length}\n`);

        // 测试 Top Keys
        console.log('2. 测试 getTopVirtualKeys...');
        const start2 = Date.now();
        const topKeys = await AnalyticsService.getTopVirtualKeys(5);
        const time2 = Date.now() - start2;
        console.log(`   时间: ${time2}ms, 虚拟键数: ${topKeys.length}\n`);

        // 测试缓存统计
        console.log('3. 测试 getCacheStats...');
        const start3 = Date.now();
        const cacheStats = await AnalyticsService.getCacheStats();
        const time3 = Date.now() - start3;
        console.log(`   时间: ${time3}ms, 统计:`, cacheStats);

    } catch (error) {
        console.error('测试失败:', error);
    } finally {
        // 断开 Redis 连接
        const client = await RedisService.connect();
        await client.disconnect();
        console.log('Redis 连接已断开');
    }
}

debugPerformance();
