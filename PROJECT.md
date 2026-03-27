# FutureLab 文件共享 (futurelab-box)

## 项目信息

- **名称**: FutureLab 文件共享
- **网址**: http://49.234.51.29:8080
- **密码**: byd123

## 技术架构

- **后端**: Node.js + Express.js
- **前端**: 纯 HTML/CSS/JS（无框架）
- **文件上传**: multer（Node.js 中间件）
- **部署**: PM2 进程管理

## 核心功能

1. **用户认证** - 密码登录（cookie session）
2. **文件上传** - 支持任意文件类型，显示进度条
3. **文件列表** - 显示文件名、大小、日期
4. **文件下载** - 直接下载
5. **文件删除** - 确认后删除

## 目录结构

```
/root/futurelab-box/
├── index.js          # 主程序
├── uploads/          # 上传文件目录
├── package.json
└── node_modules/
```

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | / | 主页面（需登录） |
| GET | /login | 登录页面 |
| POST | /login | 登录处理 |
| GET | /files | 获取文件列表 |
| POST | /upload | 上传文件 |
| DELETE | /delete/:filename | 删除文件 |

## PM2 管理

```bash
pm2 start index.js --name futurelab-box
pm2 stop futurelab-box
pm2 restart futurelab-box
pm2 logs futurelab-box
```

## 维护记录

- 2026-03-16: 完全重写，解决上传问题
