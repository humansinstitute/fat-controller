module.exports = {
  apps: [
    {
      name: 'fcdev',
      script: 'dist/index.js',
      args: 'daemon',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production'
      },
      env_development: {
        NODE_ENV: 'development'
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_file: './logs/combined.log',
      time: true,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s'
    }
  ]
};