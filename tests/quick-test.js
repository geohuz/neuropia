require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

console.log('🔍 Quick Environment Check\n');

// 检查必要的环境变量
const requiredEnvVars = ['DASHSCOPE_API_KEY', 'REDIS_URL', 'POSTGREST_URL'];
const optionalEnvVars = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];

console.log('Required Environment Variables:');
requiredEnvVars.forEach(envVar => {
    const value = process.env[envVar];
    console.log(`  ${envVar}: ${value ? '✓' : '✗'} ${value ? 'Configured' : 'MISSING'}`);
});

console.log('\nOptional Environment Variables:');
optionalEnvVars.forEach(envVar => {
    const value = process.env[envVar];
    console.log(`  ${envVar}: ${value ? '✓ Configured' : '○ Not configured'}`);
});

console.log('\n🧪 Testing Model to Provider Mapping...');

const testModels = ['qwen-turbo', 'qwen-plus', 'gpt-3.5-turbo', 'claude-2', 'unknown-model'];
const { inferProviderFromModel } = require('../shared/utils/modelUtils');

testModels.forEach(model => {
    const provider = inferProviderFromModel(model);
    console.log(`  ${model} → ${provider}`);
});

console.log('\n✅ Quick check completed');
