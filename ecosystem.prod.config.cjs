module.exports = {
  apps: [
    {
      name: 'fcprod',
      script: 'dist/index.js',
      args: 'daemon',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3001
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: './logs/out-prod.log',
      error_file: './logs/error-prod.log',
      log_file: './logs/combined-prod.log',
      time: true,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s'
    }
  ]
};