// neuropia_api_gateway/src/middleware/auth.js
class AuthMiddleware {
    static authenticate(req, res, next) {
        // 跳过健康检查
        if (req.path === '/health') {
            return next();
        }

        // 检查认证头（JWT Token）
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                error: 'Authentication required',
                code: 'MISSING_AUTH_TOKEN'
            });
        }

        const token = authHeader.substring(7); // 移除 "Bearer " 前缀

        try {
            // 验证 JWT Token
            // 这里需要根据您的 JWT 配置来实现
            const decoded = this.verifyToken(token);
            req.user = decoded;
            next();
        } catch (error) {
            return res.status(401).json({
                error: 'Invalid or expired token',
                code: 'INVALID_TOKEN'
            });
        }
    }

    static verifyToken(token) {
        // 这里实现 JWT 验证逻辑
        // 示例：使用 jsonwebtoken 库
        const jwt = require('jsonwebtoken');
        return jwt.verify(token, process.env.JWT_SECRET);
    }

    // 可选：管理员权限检查
    static requireAdmin(req, res, next) {
        if (req.user && req.user.role === 'admin') {
            next();
        } else {
            res.status(403).json({
                error: 'Admin privileges required',
                code: 'ADMIN_REQUIRED'
            });
        }
    }
}

module.exports = { AuthMiddleware };
