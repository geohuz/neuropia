// neuropia_api_gateway/src/server.js
const NeuropiaGateway = require('./app');

async function startServer() {
    try {
        console.log('🚀 Starting Neuropia API Gateway...');

        const gateway = new NeuropiaGateway();
        const server = await gateway.start(process.env.PORT || 3001);

        console.log('✅ Neuropia API Gateway started successfully');

        return server;
    } catch (error) {
        console.error('❌ Failed to start Neuropia API Gateway:', error);
        process.exit(1);
    }
}

// 只有直接运行此文件时才启动服务器
if (require.main === module) {
    startServer();
}

module.exports = startServer;
