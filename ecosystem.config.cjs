// pm2 config - chay: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "print-station",
      script: "server.js",
      cwd: __dirname,
      autorestart: true,
      // server.js tu exit khi thieu CF_TEAM_DOMAIN/CF_ACCESS_AUD - gioi han restart
      // de khong loop vo han khi .env chua cau hinh
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 3000,
      windowsHide: true,
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-err.log",
      time: true,
    },
  ],
};
