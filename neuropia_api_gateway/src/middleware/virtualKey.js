// neuropia_api_gateway/src/middleware/virtualKey.js
class VirtualKeyMiddleware {
    static async validate(req, res, next) {
        try {
            // 🎯 修复：使用 VirtualKeyMiddleware.extractVirtualKey
            const virtualKey = VirtualKeyMiddleware.extractVirtualKey(req);

            if (!virtualKey) {
                return res.status(401).json({
                    error: "Virtual key required",
                    code: "MISSING_VIRTUAL_KEY"
                });
            }

            // 🎯 修复：使用 VirtualKeyMiddleware.isValidFormat
            if (!VirtualKeyMiddleware.isValidFormat(virtualKey)) {
                return res.status(401).json({
                    error: "Invalid virtual key format",
                    code: "INVALID_VIRTUAL_KEY_FORMAT"
                });
            }

            // 设置基础上下文
            req.userContext = {
                virtual_key: virtualKey
            };

            console.log('✅ Virtual Key 格式验证通过:', virtualKey);
            next();
        } catch (error) {
            console.error("Virtual key validation error:", error);
            res.status(500).json({
                error: "Authentication failed",
                code: "AUTHENTICATION_ERROR"
            });
        }
    }

    static isValidFormat(virtualKey) {
        return virtualKey && virtualKey.length > 10;
    }

    static extractVirtualKey(req) {
        const authHeader = req.headers.authorization;
        if (authHeader) {
            if (authHeader.startsWith('Bearer ')) {
                return authHeader.substring(7);
            }
            return authHeader;
        }
        if (req.headers['x-virtual-key']) {
            return req.headers['x-virtual-key'];
        }
        if (req.query.virtual_key) {
            return req.query.virtual_key;
        }
        return null;
    }
}

module.exports = { VirtualKeyMiddleware };
