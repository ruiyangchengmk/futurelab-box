# FutureLab 文件共享

一个简洁高效的文件共享服务，支持大文件分片上传和断点续传。

## 🌐 在线访问

- **网址**: http://49.234.51.29:8080
- **密码**: `byd123`

## ✨ 功能特性

- 🔐 **密码保护** - 简单的 cookie-based 认证
- 📤 **大文件上传** - 支持最大 500MB 文件
- 🔄 **断点续传** - 大于 10MB 的文件自动分片上传，支持断点续传
- 📊 **上传进度** - 实时显示上传进度和速度
- 📁 **文件管理** - 查看、下载、删除文件
- 🎨 **现代化 UI** - 渐变深色主题界面

## 🛠 技术栈

- **后端**: Node.js + Express.js
- **文件上传**: Multer + 自定义分片上传逻辑
- **前端**: 原生 HTML/CSS/JavaScript
- **部署**: 腾讯云轻量服务器

## 🚀 快速开始

### 安装依赖

```bash
npm install
```

### 启动服务

```bash
node index.js
```

服务将在 http://localhost:8080 启动

### 使用 PM2 部署

```bash
pm2 start index.js --name futurelab-box
```

## 📁 项目结构

```
futurelab-box/
├── index.js          # 主服务器文件
├── package.json      # 项目依赖
├── uploads/          # 上传文件存储目录
├── temp_chunks/      # 分片上传临时目录
└── .gitignore        # Git 忽略配置
```

## 🔧 配置说明

在 `index.js` 中可以修改以下配置：

```javascript
const PORT = 8080;                    // 服务端口
const ACCESS_PASSWORD = 'byd123';     // 访问密码
const MAX_STORAGE = 10 * 1024 * 1024 * 1024;  // 最大存储 10GB
const CHUNK_SIZE = 5 * 1024 * 1024;   // 分片大小 5MB
```

## 📝 API 接口

### 1. 初始化分片上传
```http
POST /upload/init
Content-Type: application/json

{
  "filename": "example.zip",
  "filesize": 104857600
}
```

### 2. 上传分片
```http
POST /upload/chunk/:uploadId
Content-Type: multipart/form-data

chunk: <二进制文件>
chunkIndex: 0
```

### 3. 完成上传（合并分片）
```http
POST /upload/complete/:uploadId
```

### 4. 获取文件列表
```http
GET /files
```

### 5. 删除文件
```http
DELETE /delete/:filename
```

## 🐛 常见问题

**Q: 上传大文件时网络错误？**
A: 大于 10MB 的文件会自动使用分片上传，如果中断可以重新选择同一文件继续上传。

**Q: 如何修改密码？**
A: 修改 `index.js` 中的 `ACCESS_PASSWORD` 常量。

**Q: 如何更改端口？**
A: 修改 `index.js` 中的 `PORT` 常量，并确保防火墙放行该端口。

## 📄 许可证

MIT License

## 👤 作者

FutureLab Team
