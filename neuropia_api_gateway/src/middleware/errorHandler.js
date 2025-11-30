// neuropia_api_gateway/src/middleware/error// neuropia_api_gateway/src/middleware/errorHandler.js
function ErrorHandler(error, req, res, next) {
    console.error('🚨 Unhandled error:', {
        message: error.message,
        url: req.url,
        method: req.method,
        virtual_key: req.userContext?.virtual_key
    });

    // 已知错误类型处理
    if (error.code === 'RATE_LIMIT_EXCEEDED') {
        return res.status(429).json({
            error: "Rate limit exceeded",
            code: "RATE_LIMIT_EXCEEDED"
        });
    }

    if (error.code === 'MODEL_NOT_ALLOWED') {
        return res.status(403).json({
            error: error.message,
            code: "MODEL_NOT_ALLOWED"
        });
    }

    if (error.code === 'INSUFFICIENT_BALANCE') {
        return res.status(402).json({
            error: "Insufficient balance",
            code: "INSUFFICIENT_BALANCE"
        });
    }

    // 默认错误响应
    res.status(500).json({
        error: "Internal server error",
        code: "INTERNAL_ERROR"
    });
}

// 🎯 修复：直接导出函数
module.exports = ErrorHandler;
