export default function validateEnv() {
    const requiredEnvVars = [
        'NODE_ENV',
        'BASE_URL',
        'API_SERVICE_URL',
        'CONFIG_SERVICE_URL',
        'REDIS_HOST',
        'REDIS_PORT',
        // 'FINVU_AA_SERVICE_URL',
    ];
    for (const varName of requiredEnvVars) {
        if (!process.env[varName]) {
            throw new Error(
                `Missing required environment variable: ${varName}`
            );
        }
    }
}
