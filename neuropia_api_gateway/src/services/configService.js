// neuropia_api_gateway/src/services/configService.js
class ConfigService {
    static async getPortkeyConfig(userContext, virtualKeyConfig, requestBody) {
        try {
            const response = await fetch(
                `${process.env.CONFIG_SERVICE_URL}/generate-config`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        userContext,
                        virtualKeyConfig,
                        requestBody
                    })
                }
            );

            if (!response.ok) {
                throw new Error(`Config service error: ${response.statusText}`);
            }

            const result = await response.json();

            if (!result.success) {
                throw new Error(result.error);
            }

            return result.config;
        } catch (error) {
            console.error('Failed to get portkey config:', error);
            throw error;
        }
    }

    static async reloadConfigs() {
        try {
            const response = await fetch(
                `${process.env.CONFIG_SERVICE_URL}/reload-configs`,
                { method: 'POST' }
            );

            if (!response.ok) {
                throw new Error(`Config reload failed: ${response.statusText}`);
            }

            const result = await response.json();
            return result.success;
        } catch (error) {
            console.error('Config reload error:', error);
            return false;
        }
    }
}

module.exports = { ConfigService };
