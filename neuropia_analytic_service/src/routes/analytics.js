// src/routes/analytics.js
const express = require('express');
const AnalyticsService = require('../services/analyticsService');
const Redis = require('@shared/clients/redis_op');
const router = express.Router();

// 获取实时监控数据
router.get('/monitoring/stream', async (req, res) => {
    const startTime = Date.now();
    console.log('🚀 监控流请求开始');

    try {
        const { limit = 50 } = req.query;
        console.log('1. 准备调用 AnalyticsService...');

        const serviceStart = Date.now();
        const records = await AnalyticsService.getMonitoringStream('api_monitoring_stream', parseInt(limit));
        const serviceTime = Date.now() - serviceStart;

        console.log(`2. AnalyticsService 完成: ${serviceTime}ms`);

        const totalTime = Date.now() - startTime;
        console.log(`✅ 监控流请求完成: ${totalTime}ms (服务: ${serviceTime}ms)`);

        res.json({ success: true, data: records });
    } catch (error) {
        const totalTime = Date.now() - startTime;
        console.log(`❌ 监控流请求错误: ${totalTime}ms`, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取虚拟键统计
router.get('/stats/virtual-key/:virtualKey', async (req, res) => {
    const startTime = Date.now();
    console.log('🚀 虚拟键统计请求开始');

    try {
        const { virtualKey } = req.params;
        console.log('1. 准备调用 AnalyticsService...');

        const serviceStart = Date.now();
        const stats = await AnalyticsService.getVirtualKeyStats(virtualKey);
        const serviceTime = Date.now() - serviceStart;

        console.log(`2. AnalyticsService 完成: ${serviceTime}ms`);

        const totalTime = Date.now() - startTime;
        console.log(`✅ 虚拟键统计请求完成: ${totalTime}ms (服务: ${serviceTime}ms)`);

        res.json({ success: true, data: stats });
    } catch (error) {
        const totalTime = Date.now() - startTime;
        console.log(`❌ 虚拟键统计请求错误: ${totalTime}ms`, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取提供商统计
router.get('/stats/provider/:provider', async (req, res) => {
    const startTime = Date.now();
    console.log('🚀 提供商统计请求开始');

    try {
        const { provider } = req.params;
        console.log('1. 准备调用 AnalyticsService...');

        const serviceStart = Date.now();
        const stats = await AnalyticsService.getProviderStats(provider);
        const serviceTime = Date.now() - serviceStart;

        console.log(`2. AnalyticsService 完成: ${serviceTime}ms`);

        const totalTime = Date.now() - startTime;
        console.log(`✅ 提供商统计请求完成: ${totalTime}ms (服务: ${serviceTime}ms)`);

        res.json({ success: true, data: stats });
    } catch (error) {
        const totalTime = Date.now() - startTime;
        console.log(`❌ 提供商统计请求错误: ${totalTime}ms`, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取Top虚拟键
// 获取Top虚拟键
router.get('/stats/top-keys', async (req, res) => {
    const startTime = Date.now();
    console.log('🚀 Top虚拟键请求开始');

    try {
        const { limit = 10 } = req.query;
        console.log('1. 准备调用 AnalyticsService...');

        const serviceStart = Date.now();
        const topKeys = await AnalyticsService.getTopVirtualKeys(parseInt(limit));
        const serviceTime = Date.now() - serviceStart;

        console.log(`2. AnalyticsService 完成: ${serviceTime}ms`);
        console.log(`🔍 AnalyticsService 返回数据:`, topKeys);
        console.log(`🔍 返回数据类型:`, Array.isArray(topKeys) ? '数组' : typeof topKeys);
        console.log(`🔍 数组长度:`, Array.isArray(topKeys) ? topKeys.length : '不是数组');

        const totalTime = Date.now() - startTime;
        console.log(`✅ Top虚拟键请求完成: ${totalTime}ms (服务: ${serviceTime}ms)`);

        res.json({ success: true, data: topKeys });
    } catch (error) {
        const totalTime = Date.now() - startTime;
        console.log(`❌ Top虚拟键请求错误: ${totalTime}ms`, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取缓存统计
router.get('/stats/cache', async (req, res) => {
    const startTime = Date.now();
    console.log('🚀 缓存统计请求开始');

    try {
        console.log('1. 准备调用 AnalyticsService...');

        const serviceStart = Date.now();
        const cacheStats = await AnalyticsService.getCacheStats();
        const serviceTime = Date.now() - serviceStart;

        console.log(`2. AnalyticsService 完成: ${serviceTime}ms`);

        const totalTime = Date.now() - startTime;
        console.log(`✅ 缓存统计请求完成: ${totalTime}ms (服务: ${serviceTime}ms)`);

        res.json({ success: true, data: cacheStats });
    } catch (error) {
        const totalTime = Date.now() - startTime;
        console.log(`❌ 缓存统计请求错误: ${totalTime}ms`, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🔥 新增：获取错误统计
router.get('/stats/errors', async (req, res) => {
    const startTime = Date.now();
    console.log('🚀 错误统计请求开始');

    try {
        console.log('1. 准备从Redis获取错误统计...');

        const serviceStart = Date.now();
        const client = await Redis.connect();
        const errorKeys = await client.keys('errors:*');

        const errorStats = {};
        for (const key of errorKeys) {
            const virtualKey = key.replace('errors:', '');
            const errors = await client.hGetAll(key);

            // 过滤掉空值并转换为数字
            const filteredErrors = {};
            Object.entries(errors).forEach(([statusCode, count]) => {
                const numCount = parseInt(count);
                if (!isNaN(numCount) && numCount > 0) {
                    filteredErrors[statusCode] = numCount;
                }
            });

            if (Object.keys(filteredErrors).length > 0) {
                errorStats[virtualKey] = filteredErrors;
            }
        }

        const serviceTime = Date.now() - serviceStart;

        console.log(`2. 错误统计获取完成: ${serviceTime}ms`);

        const totalTime = Date.now() - startTime;
        console.log(`✅ 错误统计请求完成: ${totalTime}ms (服务: ${serviceTime}ms)`);

        res.json({
            success: true,
            data: errorStats,
            total_virtual_keys: Object.keys(errorStats).length
        });
    } catch (error) {
        const totalTime = Date.now() - startTime;
        console.log(`❌ 错误统计请求错误: ${totalTime}ms`, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🔥 新增：获取成本分析
router.get('/stats/costs', async (req, res) => {
    const startTime = Date.now();
    console.log('🚀 成本分析请求开始');

    try {
        console.log('1. 准备从Redis获取成本统计...');

        const serviceStart = Date.now();
        const client = await Redis.connect();
        const costKeys = await client.keys('user_costs:*');

        const costStats = [];
        for (const key of costKeys) {
            const virtualKey = key.replace('user_costs:', '');
            const stats = await client.hGetAll(key);

            const totalTokens = parseInt(stats.total_tokens) || 0;
            const promptTokens = parseInt(stats.prompt_tokens) || 0;
            const completionTokens = parseInt(stats.completion_tokens) || 0;
            const totalRequests = parseInt(stats.total_requests) || 0;

            // 简单的成本估算（假设 $0.002 / 1K tokens）
            const estimatedCost = totalTokens * 0.000002;

            if (totalTokens > 0) {
                costStats.push({
                    virtual_key: virtualKey,
                    total_requests: totalRequests,
                    total_tokens: totalTokens,
                    prompt_tokens: promptTokens,
                    completion_tokens: completionTokens,
                    estimated_cost: estimatedCost.toFixed(6),
                    last_updated: stats.last_updated || '未知'
                });
            }
        }

        // 按成本排序
        costStats.sort((a, b) => parseFloat(b.estimated_cost) - parseFloat(a.estimated_cost));

        const serviceTime = Date.now() - serviceStart;

        console.log(`2. 成本分析完成: ${serviceTime}ms`);

        const totalTime = Date.now() - startTime;
        console.log(`✅ 成本分析请求完成: ${totalTime}ms (服务: ${serviceTime}ms)`);

        res.json({
            success: true,
            data: costStats,
            total_users: costStats.length,
            total_estimated_cost: costStats.reduce((sum, user) => sum + parseFloat(user.estimated_cost), 0).toFixed(6)
        });
    } catch (error) {
        const totalTime = Date.now() - startTime;
        console.log(`❌ 成本分析请求错误: ${totalTime}ms`, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🔥 新增：获取提供商排名
router.get('/stats/top-providers', async (req, res) => {
    const startTime = Date.now();
    console.log('🚀 提供商排名请求开始');

    try {
        const { limit = 10 } = req.query;
        console.log('1. 准备获取提供商排名...');

        const serviceStart = Date.now();
        const topProviders = await Redis.monitoring.getTopProviders(parseInt(limit));

        const providerStats = await Promise.all(
            topProviders.map(async ({ value: provider, score: tokens }) => {
                const stats = await AnalyticsService.getProviderStats(provider);
                return {
                    provider,
                    total_tokens: tokens,
                    total_requests: stats?.total_requests || 0,
                    cache_hits: stats?.cache_hits || 0,
                    total_retries: stats?.total_retries || 0,
                    daily_requests: stats?.daily_requests || 0,  // ✅ 添加每日请求
                    daily_tokens: stats?.daily_tokens || 0       // ✅ 添加每日token
                };
            })
        );

        const serviceTime = Date.now() - serviceStart;

        console.log(`2. 提供商排名完成: ${serviceTime}ms`);

        const totalTime = Date.now() - startTime;
        console.log(`✅ 提供商排名请求完成: ${totalTime}ms (服务: ${serviceTime}ms)`);

        res.json({
            success: true,
            data: providerStats
        });
    } catch (error) {
        const totalTime = Date.now() - startTime;
        console.log(`❌ 提供商排名请求错误: ${totalTime}ms`, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
