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
      out_file: './logs/out-9.log',
      error_file: './logs/error-9.log',
      log_file: './logs/combined-9.log',
      time: true,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
      name: 'fcdev',
      script: 'dist/index.js',
      args: 'daemon',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'development',
        PORT: 3002
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: './logs/out-dev.log',
      error_file: './logs/error-dev.log',
      log_file: './logs/combined-dev.log',
      time: true,
      restart_delay: 2000,
      max_restarts: 20,
      min_uptime: '5s'
    }
  ]
};