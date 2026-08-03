module.exports = {
    apps: [{
        name: "ai-product-catalogue",
        script: "server.js",
        instances: "1",
        autorestart: true,
        watch: false,
        max_memory_restart: '1G',
        env: {
            NODE_ENV: "production",
            PORT: 3002
        },
        env_development: {
            NODE_ENV: "development",
            TEST_MODE: "true"
        }
    }]
};
