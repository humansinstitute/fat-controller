module.exports = {
  apps: [
    {
      name: 'fcdev',
      script: 'tsx',
      args: 'src/index.ts daemon',
      instances: 1,
      autorestart: true,
      watch: ['src'],
      watch_delay: 1000,
      ignore_watch: ['node_modules', 'logs', 'data'],
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