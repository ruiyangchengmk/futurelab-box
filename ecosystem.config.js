module.exports = {
  apps: [
    {
      name: 'futurelab-box',
      script: 'index.js',
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || '8080',
        ACCESS_PASSWORD: process.env.ACCESS_PASSWORD,
        SESSION_SECRET: process.env.SESSION_SECRET,
        UPLOAD_DIR: process.env.UPLOAD_DIR || '/root/futurelab-box/uploads',
        TEMP_DIR: process.env.TEMP_DIR || '/root/futurelab-box/temp_chunks',
        MAX_STORAGE_BYTES: process.env.MAX_STORAGE_BYTES || String(10 * 1024 * 1024 * 1024),
        MAX_FILE_BYTES: process.env.MAX_FILE_BYTES || String(500 * 1024 * 1024)
      }
    }
  ]
};
