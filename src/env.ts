export default function validateEnv() {
    const requiredEnvVars = [
        'NODE_ENV',
        'API_SERVICE_URL',
        'CONFIG_SERVICE_URL',
        'REDIS_HOST',
        'REDIS_PORT',
    ];
    for (const varName of requiredEnvVars) {
        if (!process.env[varName]) {
            throw new Error(
                `Missing required environment variable: ${varName}`
            );
        }
    }
}
