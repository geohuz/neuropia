const express = require('express');
const AnalyticsService = require('../services/analyticsService');
const router = express.Router();

router.get('/monitoring/stream', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const data = await AnalyticsService.getMonitoringStream('api_monitoring_stream', limit);
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/stats/virtual-key/:virtualKey', async (req, res) => {
    try {
        const stats = await AnalyticsService.getVirtualKeyStats(req.params.virtualKey);
        res.json({ success: true, data: stats });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/stats/provider/:provider', async (req, res) => {
    try {
        const stats = await AnalyticsService.getProviderStats(req.params.provider);
        res.json({ success: true, data: stats });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/stats/top-keys', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const topKeys = await AnalyticsService.getTopVirtualKeys(limit);
        res.json({ success: true, data: topKeys });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/stats/top-providers', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const topProviders = await AnalyticsService.getTopProviders(limit);

        const stats = await Promise.all(topProviders.map(async ({ value, score }) => {
            const detail = await AnalyticsService.getProviderStats(value);
            return { provider: value, total_tokens: score, ...detail };
        }));

        res.json({ success: true, data: stats });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/stats/cache', async (req, res) => {
    try {
        const data = await AnalyticsService.getCacheStats();
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/stats/errors', async (req, res) => {
    try {
        const data = await AnalyticsService.getErrorStats();
        res.json({ success: true, data, total_virtual_keys: Object.keys(data).length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/stats/costs', async (req, res) => {
    try {
        const data = await AnalyticsService.getCostStats();
        res.json({ success: true, data: data.costs, total_users: data.total_users, total_estimated_cost: data.total_estimated_cost });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
