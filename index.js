const express = require('express');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const app = express();
const PORT = Number(process.env.PORT || 8080);
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const COOKIE_NAME = 'futurelab_auth';
const COOKIE_MAX_AGE = 24 * 60 * 60 * 1000;
const MAX_STORAGE = Number(process.env.MAX_STORAGE_BYTES || 10 * 1024 * 1024 * 1024); // 10GB
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_BYTES || 500 * 1024 * 1024); // 500MB
const CHUNK_SIZE = 5 * 1024 * 1024; // 每块5MB
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'));
const TEMP_DIR = path.resolve(process.env.TEMP_DIR || path.join(__dirname, 'temp_chunks'));
const METADATA_FILE = path.join(UPLOAD_DIR, '.metadata.json');

if (!ACCESS_PASSWORD || !SESSION_SECRET) {
  console.error('请设置 ACCESS_PASSWORD 和 SESSION_SECRET 环境变量后再启动服务。');
  process.exit(1);
}

// 中间件
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// 确保数据目录存在
for (const dir of [UPLOAD_DIR, TEMP_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// 清理超过24小时的临时文件
function cleanupOldChunks() {
  if (!fs.existsSync(TEMP_DIR)) return;
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000;
  
  fs.readdirSync(TEMP_DIR).forEach(dir => {
    const dirPath = path.join(TEMP_DIR, dir);
    try {
      const stat = fs.statSync(dirPath);
      if (stat.isDirectory() && (now - stat.mtimeMs) > maxAge) {
        fs.rmSync(dirPath, { recursive: true });
        console.log(`清理过期分片目录: ${dir}`);
      }
    } catch(e) {}
  });
}
cleanupOldChunks();

// 生成安全文件名
function generateSafeFilename(originalName) {
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  const basename = path.basename(normalizeOriginalName(originalName || 'file'));
  const encodedName = Buffer.from(basename).toString('base64url');
  return `${timestamp}-${random}-${encodedName}`;
}

function countCjk(value) {
  const matches = String(value).match(/[\u3400-\u9fff]/g);
  return matches ? matches.length : 0;
}

function normalizeOriginalName(originalName) {
  const name = path.basename(String(originalName || 'file'));
  const repaired = Buffer.from(name, 'latin1').toString('utf8');
  const hasMojibakeControls = /[\u0080-\u009f]/.test(name);

  if (!repaired.includes('�') && (hasMojibakeControls || countCjk(repaired) > countCjk(name))) {
    return path.basename(repaired);
  }

  return name;
}

function getOriginalFilename(storedName) {
  const parts = String(storedName).split('-');
  if (parts.length < 3) return storedName;

  const encodedName = parts.slice(2).join('-');
  for (const encoding of ['base64url', 'base64']) {
    try {
      const decoded = Buffer.from(encodedName, encoding).toString('utf8');
      if (decoded && decoded === path.basename(decoded)) {
        return normalizeOriginalName(decoded);
      }
    } catch (err) {}
  }

  return storedName;
}

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function passwordsMatch(candidate) {
  return crypto.timingSafeEqual(hashValue(candidate || ''), hashValue(ACCESS_PASSWORD));
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function createAuthToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + COOKIE_MAX_AGE })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [payload, signature] = parts;
  const expected = sign(payload);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    return false;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isFinite(data.exp) && data.exp > Date.now();
  } catch (err) {
    return false;
  }
}

function setAuthCookie(res) {
  res.cookie(COOKIE_NAME, createAuthToken(), {
    maxAge: COOKIE_MAX_AGE,
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.COOKIE_SECURE === 'true',
    path: '/'
  });
}

function isAuthenticated(req) {
  return verifyAuthToken(req.cookies && req.cookies[COOKIE_NAME]);
}

function requireAuth(req, res, next) {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: '未登录' });
  }
  next();
}

function getUploadFilePath(filename) {
  if (!filename || typeof filename !== 'string') return null;
  if (filename === path.basename(METADATA_FILE)) return null;
  const filePath = path.resolve(UPLOAD_DIR, filename);
  if (!filePath.startsWith(UPLOAD_DIR + path.sep)) return null;
  return filePath;
}

function getChunkDir(uploadId) {
  if (!/^[a-f0-9]{32}$/.test(uploadId || '')) return null;
  const chunkDir = path.resolve(TEMP_DIR, uploadId);
  if (!chunkDir.startsWith(TEMP_DIR + path.sep)) return null;
  return chunkDir;
}

function getUsedStorageBytes() {
  if (!fs.existsSync(UPLOAD_DIR)) return 0;
  return fs.readdirSync(UPLOAD_DIR).reduce((total, filename) => {
    if (filename === path.basename(METADATA_FILE)) return total;
    const filepath = getUploadFilePath(filename);
    if (!filepath) return total;
    const stats = fs.statSync(filepath);
    return stats.isFile() ? total + stats.size : total;
  }, 0);
}

function loadMetadata() {
  try {
    if (!fs.existsSync(METADATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
  } catch (err) {
    console.error('读取文件元数据失败:', err);
    return {};
  }
}

function saveMetadata(metadata) {
  const tmpFile = `${METADATA_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(metadata, null, 2));
  fs.renameSync(tmpFile, METADATA_FILE);
}

function rememberUploadedFile(filename, originalName, size) {
  const metadata = loadMetadata();
  metadata[filename] = {
    originalName: normalizeOriginalName(originalName || filename),
    size,
    uploadedAt: new Date().toISOString()
  };
  saveMetadata(metadata);
}

function forgetUploadedFile(filename) {
  const metadata = loadMetadata();
  if (!metadata[filename]) return;
  delete metadata[filename];
  saveMetadata(metadata);
}

function listUploadedFiles() {
  if (!fs.existsSync(UPLOAD_DIR)) return [];
  const metadata = loadMetadata();
  return fs.readdirSync(UPLOAD_DIR)
    .map(filename => {
      if (filename === path.basename(METADATA_FILE)) return null;
      const filepath = getUploadFilePath(filename);
      if (!filepath) return null;
      const stats = fs.statSync(filepath);
      if (!stats.isFile()) return null;
      const fileMeta = metadata[filename] || {};
      const uploadedAt = fileMeta.uploadedAt ? new Date(fileMeta.uploadedAt) : stats.mtime;
      return {
        name: fileMeta.originalName || getOriginalFilename(filename),
        filename,
        size: Number(fileMeta.size) || stats.size,
        displaySize: formatSize(Number(fileMeta.size) || stats.size),
        date: uploadedAt.toLocaleString('zh-CN'),
        mtimeMs: uploadedAt.getTime()
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(({ mtimeMs, ...file }) => file);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 存储配置
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    const safeName = generateSafeFilename(file.originalname);
    cb(null, safeName);
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    timeout: 1800 * 1000
  }
});

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: CHUNK_SIZE + 1024 * 1024,
    files: 1,
    fields: 1
  }
}).any();

// 禁用请求超时
app.use((req, res, next) => {
  req.setTimeout(0);
  res.setTimeout(0);
  next();
});

// ============ 断点续传 API ============

// 初始化分片上传
app.post('/upload/init', (req, res) => {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: '未登录' });
  }
  
  const { filename } = req.body;
  const filesize = Number(req.body.filesize);
  const chunkSize = Number(req.body.chunkSize || CHUNK_SIZE);
  if (!filename || !Number.isInteger(filesize) || filesize <= 0 || !Number.isInteger(chunkSize) || chunkSize <= 0) {
    return res.status(400).json({ error: '缺少参数' });
  }
  if (filesize > MAX_FILE_SIZE) {
    return res.status(400).json({ error: `单个文件最大支持 ${formatSize(MAX_FILE_SIZE)}` });
  }
  if (chunkSize > CHUNK_SIZE) {
    return res.status(400).json({ error: `分片最大支持 ${formatSize(CHUNK_SIZE)}` });
  }
  if (getUsedStorageBytes() + filesize > MAX_STORAGE) {
    return res.status(400).json({ error: `空间不足，当前上限 ${formatSize(MAX_STORAGE)}` });
  }
  
  const uploadId = crypto.randomBytes(16).toString('hex');
  const chunkDir = path.join(TEMP_DIR, uploadId);
  fs.mkdirSync(chunkDir, { recursive: true });
  
  const totalChunks = Math.ceil(filesize / chunkSize);
  
  // 保存上传信息
  fs.writeFileSync(
    path.join(chunkDir, 'info.json'),
    JSON.stringify({ filename, filesize, chunkSize, totalChunks, originalName: filename })
  );
  
  res.json({ uploadId, totalChunks, chunkSize });
});

// 上传分片
app.post('/upload/chunk/:uploadId', (req, res) => {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: '未登录' });
  }
  
  const { uploadId } = req.params;
  const chunkDir = getChunkDir(uploadId);
  if (!chunkDir) {
    return res.status(400).json({ error: '上传 ID 无效' });
  }
  const infoPath = path.join(chunkDir, 'info.json');
  
  if (!fs.existsSync(infoPath)) {
    return res.status(404).json({ error: '上传不存在或已过期' });
  }
  
  chunkUpload(req, res, function(err) {
    if (err) {
      return res.status(500).json({ error: '分片上传失败: ' + err.message });
    }
    
    // 解析 chunkIndex 从 request body
    let chunkIndex = req.body.chunkIndex;
    if (chunkIndex === undefined || chunkIndex === null) {
      return res.status(400).json({ error: '缺少 chunkIndex 参数' });
    }
    chunkIndex = parseInt(chunkIndex, 10);
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= info.totalChunks) {
      return res.status(400).json({ error: 'chunkIndex 无效' });
    }
    
    // 找到上传的文件
    const chunkFile = req.files && req.files.find(f => f.fieldname === 'chunk');
    if (!chunkFile) {
      return res.status(400).json({ error: '没有分片文件' });
    }
    if (chunkFile.size > info.chunkSize) {
      return res.status(400).json({ error: '分片大小超过限制' });
    }
    
    const chunkPath = path.join(chunkDir, `chunk_${chunkIndex}`);
    fs.writeFileSync(chunkPath, chunkFile.buffer);
    
    res.json({ success: true, chunkIndex });
  });
});

// 获取已上传的分片列表
app.get('/upload/status/:uploadId', (req, res) => {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: '未登录' });
  }
  
  const { uploadId } = req.params;
  const chunkDir = getChunkDir(uploadId);
  if (!chunkDir) {
    return res.status(400).json({ error: '上传 ID 无效' });
  }
  const infoPath = path.join(chunkDir, 'info.json');
  
  if (!fs.existsSync(infoPath)) {
    return res.status(404).json({ error: '上传不存在或已过期' });
  }
  
  const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  const uploadedChunks = [];
  
  for (let i = 0; i < info.totalChunks; i++) {
    const chunkPath = path.join(chunkDir, `chunk_${i}`);
    if (fs.existsSync(chunkPath)) {
      uploadedChunks.push(i);
    }
  }
  
  res.json({ uploadedChunks, totalChunks: info.totalChunks });
});

// 完成上传（合并分片）- 使用流式处理避免内存溢出
app.post('/upload/complete/:uploadId', async (req, res) => {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: '未登录' });
  }
  
  const { uploadId } = req.params;
  const chunkDir = getChunkDir(uploadId);
  if (!chunkDir) {
    return res.status(400).json({ error: '上传 ID 无效' });
  }
  const infoPath = path.join(chunkDir, 'info.json');
  
  if (!fs.existsSync(infoPath)) {
    return res.status(404).json({ error: '上传不存在或已过期' });
  }
  
  const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  const safeName = generateSafeFilename(info.originalName);
  const finalPath = path.join(UPLOAD_DIR, safeName);
  if (getUsedStorageBytes() + Number(info.filesize) > MAX_STORAGE) {
    return res.status(400).json({ error: `空间不足，当前上限 ${formatSize(MAX_STORAGE)}` });
  }
  
  // 检查所有分片是否存在
  for (let i = 0; i < info.totalChunks; i++) {
    const chunkPath = path.join(chunkDir, `chunk_${i}`);
    if (!fs.existsSync(chunkPath)) {
      return res.status(400).json({ error: `缺少分片 ${i}` });
    }
  }
  
  // 使用流式合并避免内存溢出
  const writeStream = fs.createWriteStream(finalPath);
  
  try {
    for (let i = 0; i < info.totalChunks; i++) {
      const chunkPath = path.join(chunkDir, `chunk_${i}`);
      const readStream = fs.createReadStream(chunkPath);
      await pipeline(readStream, writeStream, { end: false });
    }
    writeStream.end();
    
    // 等待写入完成
    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
    
    // 清理临时文件
    fs.rmSync(chunkDir, { recursive: true });
    rememberUploadedFile(safeName, info.originalName, Number(info.filesize));
    
    res.json({ success: true, filename: safeName, size: info.filesize });
  } catch (err) {
    // 清理失败的文件
    if (fs.existsSync(finalPath)) {
      fs.unlinkSync(finalPath);
    }
    console.error('合并分片失败:', err);
    res.status(500).json({ error: '合并文件失败: ' + err.message });
  }
});

// ============ 原有 API ============

// 登录页面
app.get('/login', (req, res) => {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>登录 - FutureLab</title>
  <style>
    body { font-family: Arial, sans-serif; background: #1a1a2e; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
    .login { background: #16213e; padding: 40px; border-radius: 10px; text-align: center; }
    input { padding: 10px; margin: 10px 0; border-radius: 5px; border: none; }
    button { padding: 10px 30px; background: #00d9ff; border: none; border-radius: 5px; cursor: pointer; }
    .error { color: #ff7a85; min-height: 24px; margin-top: 10px; }
  </style>
</head>
<body>
  <div class="login">
    <h1>FutureLab 文件共享</h1>
    <form id="loginForm">
      <input type="password" id="password" name="password" placeholder="请输入密码" required>
      <br>
      <button type="submit">登录</button>
    </form>
    <div id="error" class="error"></div>
  </div>
  <script>
    document.getElementById('loginForm').onsubmit = function(e) {
      e.preventDefault();
      var error = document.getElementById('error');
      error.textContent = '';
      fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: document.getElementById('password').value })
      })
        .then(function(res) {
          if (!res.ok) throw new Error('密码错误');
          return res.json();
        })
        .then(function() { location.href = '/'; })
        .catch(function(err) { error.textContent = err.message; });
    };
  </script>
</body>
</html>`;
  res.send(html);
});

app.get('/check', (req, res) => {
  res.json({ authorized: isAuthenticated(req) });
});

app.post('/login', (req, res) => {
  const password = req.body.password;
  if (passwordsMatch(password)) {
    setAuthCookie(res);
    res.json({ success: true });
  } else {
    res.status(401).json({ error: '密码错误' });
  }
});

app.get('/files', (req, res) => {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: '未登录' });
  }
  
  res.json(listUploadedFiles());
});

// 单文件上传（保留小文件快速上传）
app.post('/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '没有文件' });
  }
  if (getUsedStorageBytes() > MAX_STORAGE) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: `空间不足，当前上限 ${formatSize(MAX_STORAGE)}` });
  }
  rememberUploadedFile(req.file.filename, req.file.originalname, req.file.size);
  
  res.json({ success: true, filename: req.file.filename });
});

app.get('/download/:filename', (req, res) => {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: '未登录' });
  }

  const filepath = getUploadFilePath(req.params.filename);
  if (!filepath || !fs.existsSync(filepath)) {
    return res.status(404).json({ error: '文件不存在' });
  }

  res.download(filepath, getOriginalFilename(req.params.filename));
});

app.delete('/delete/:filename', (req, res) => {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: '未登录' });
  }
  
  const filepath = getUploadFilePath(req.params.filename);
  
  if (!filepath || !fs.existsSync(filepath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  
  try {
    fs.unlinkSync(filepath);
    forgetUploadedFile(req.params.filename);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  if (!isAuthenticated(req)) {
    return res.redirect('/login');
  }
  
  const files = listUploadedFiles();
  
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FutureLab 文件共享</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, Arial, sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #fff; min-height: 100vh; padding: 20px; }
    h1 { text-align: center; margin-bottom: 30px; color: #00d9ff; }
    .container { max-width: 900px; margin: 0 auto; }
    .upload-section { background: rgba(255,255,255,0.05); border: 2px dashed #00d9ff; border-radius: 16px; padding: 40px; text-align: center; margin-bottom: 30px; transition: background 0.2s, border-color 0.2s, transform 0.2s; }
    .upload-section.drag-over { background: rgba(0,217,255,0.14); border-color: #00ff88; transform: translateY(-2px); }
    .upload-section h2 { color: #00d9ff; margin-bottom: 20px; }
    .progress { display: none; margin-top: 20px; }
    .progress-bar { background: #333; border-radius: 10px; height: 20px; overflow: hidden; }
    .progress-fill { background: linear-gradient(90deg, #00d9ff, #00ff88); height: 100%; width: 0%; transition: width 0.3s; }
    .progress-text { margin-top: 10px; color: #888; }
    .file-list { background: rgba(255,255,255,0.05); border-radius: 16px; padding: 20px; }
    .file-list h2 { color: #00d9ff; margin-bottom: 20px; }
    .file-item { display: flex; justify-content: space-between; align-items: center; padding: 15px; border-bottom: 1px solid rgba(255,255,255,0.1); }
    .file-item:last-child { border-bottom: none; }
    .file-info { flex: 1; overflow: hidden; }
    .file-name { font-weight: bold; word-break: break-all; }
    .file-meta { color: #a9b7c6; font-size: 0.9em; margin-top: 8px; display: flex; gap: 14px; flex-wrap: wrap; }
    .file-meta span { white-space: nowrap; }
    .file-actions { display: flex; gap: 10px; flex-shrink: 0; }
    .btn { padding: 8px 16px; border: none; border-radius: 8px; cursor: pointer; text-decoration: none; font-size: 14px; }
    .btn-download { background: #00d9ff; color: #1a1a2e; }
    .btn-delete { background: #ff4757; color: #fff; }
    #fileInput { display: none; }
    .upload-label { display: inline-block; background: linear-gradient(90deg, #00d9ff, #00ff88); color: #1a1a2e; padding: 15px 40px; border-radius: 30px; cursor: pointer; font-weight: bold; }
    .upload-label:hover { transform: scale(1.05); }
    .drop-hint { color: #a9b7c6; margin-top: 14px; font-size: 0.95em; }
    .upload-status { margin-top: 15px; padding: 10px; border-radius: 8px; display: none; }
    .upload-status.error { background: rgba(255, 71, 87, 0.2); color: #ff4757; }
    .upload-status.success { background: rgba(0, 255, 136, 0.2); color: #00ff88; }
    .upload-status.info { background: rgba(0, 217, 255, 0.2); color: #00d9ff; }
    .chunk-info { font-size: 0.85em; color: #888; margin-top: 5px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📂 FutureLab 文件共享</h1>
    
    <div class="upload-section" id="uploadSection">
      <h2>上传文件</h2>
      <label for="fileInput" class="upload-label">📤 选择文件</label>
      <input type="file" id="fileInput">
      <div class="drop-hint">或把文件拖到这里上传</div>
      
      <div class="progress" id="progress">
        <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
        <div class="progress-text" id="progressText">0%</div>
        <div class="chunk-info" id="chunkInfo"></div>
      </div>
      
      <div class="upload-status" id="uploadStatus"></div>
    </div>
    
    <div class="file-list">
      <h2>📁 文件列表 (<span id="fileCount">${files.length}</span>)</h2>
      <div id="files">
        ${files.map(f => `
        <div class="file-item">
          <div class="file-info">
            <div class="file-name">${escapeHtml(f.name)}</div>
            <div class="file-meta">
              <span>大小: ${escapeHtml(f.displaySize)}</span>
              <span>上传时间: ${escapeHtml(f.date)}</span>
            </div>
          </div>
          <div class="file-actions">
            <a href="/download/${encodeURIComponent(f.filename)}" class="btn btn-download" download="${escapeHtml(f.name)}">⬇️ 下载</a>
            <button class="btn btn-delete" onclick="deleteFile('${encodeURIComponent(f.filename)}')">🗑️ 删除</button>
          </div>
        </div>
        `).join('')}
        ${files.length === 0 ? '<p style="color:#888;text-align:center;">暂无文件</p>' : ''}
      </div>
    </div>
  </div>
  
  <script>
    function formatSize(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
    }
    
    function showStatus(msg, type) {
      var status = document.getElementById('uploadStatus');
      status.textContent = msg;
      status.className = 'upload-status ' + type;
      status.style.display = 'block';
    }
    
    var currentXhr = null;
    var uploadId = null;
    
    // 断点续传上传（大于10MB使用）
    async function chunkedUpload(file) {
      var chunkSize = 5 * 1024 * 1024; // 5MB
      var totalChunks = Math.ceil(file.size / chunkSize);
      var progress = document.getElementById('progress');
      var progressFill = document.getElementById('progressFill');
      var progressText = document.getElementById('progressText');
      var chunkInfo = document.getElementById('chunkInfo');
      
      showStatus('初始化上传...', 'info');
      progress.style.display = 'block';
      
      // 初始化
      var initRes = await fetch('/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, filesize: file.size, chunkSize: chunkSize })
      });
      var initData = await initRes.json();
      if (!initRes.ok) throw new Error(initData.error || '初始化上传失败');
      uploadId = initData.uploadId;
      totalChunks = initData.totalChunks;
      chunkSize = initData.chunkSize;
      
      showStatus('开始上传 ' + totalChunks + ' 个分片...', 'info');
      
      // 获取已上传的分片
      var statusRes = await fetch('/upload/status/' + uploadId);
      var statusData = await statusRes.json();
      var uploadedChunks = new Set(statusData.uploadedChunks || []);
      
      var completedChunks = uploadedChunks.size;
      
      // 上传每个分片
      for (var i = 0; i < totalChunks; i++) {
        if (uploadedChunks.has(i)) {
          continue; // 跳过已上传
        }
        
        var start = i * chunkSize;
        var end = Math.min(start + chunkSize, file.size);
        var chunk = file.slice(start, end);
        
        var formData = new FormData();
        formData.append('chunk', chunk);
        formData.append('chunkIndex', i);
        
        var retries = 3;
        while (retries > 0) {
          try {
            var chunkRes = await fetch('/upload/chunk/' + uploadId, {
              method: 'POST',
              body: formData
            });
            
            if (!chunkRes.ok) throw new Error('上传失败');
            break;
          } catch(e) {
            retries--;
            if (retries === 0) {
              showStatus('✗ 分片 ' + i + ' 上传失败', 'error');
              throw e;
            }
            await new Promise(r => setTimeout(r, 1000)); // 重试前等待
          }
        }
        
        completedChunks++;
        var percent = Math.round((completedChunks / totalChunks) * 100);
        progressFill.style.width = percent + '%';
        progressText.textContent = percent + '% (' + completedChunks + '/' + totalChunks + ' 分片)';
        chunkInfo.textContent = '分片 ' + (i + 1) + '/' + totalChunks + ' (' + formatSize(start) + ' / ' + formatSize(file.size) + ')';
      }
      
      // 完成合并
      showStatus('合并文件中...', 'info');
      var completeRes = await fetch('/upload/complete/' + uploadId, { method: 'POST' });
      var completeData = await completeRes.json();
      if (!completeRes.ok) throw new Error(completeData.error || '合并文件失败');
      
      if (completeData.success) {
        showStatus('✓ 上传成功！', 'success');
        setTimeout(function() { location.reload(); }, 1500);
      } else {
        showStatus('✗ ' + completeData.error, 'error');
      }
    }
    
    function startUpload(file) {
      if (!file) return;
      
      if (currentXhr) currentXhr.abort();
      
      if (!confirm('确认上传: ' + file.name + '\\n大小: ' + formatSize(file.size))) {
        return;
      }
      
      var uploadStatus = document.getElementById('uploadStatus');
      uploadStatus.style.display = 'none';
      
      // 大文件使用分片上传
      if (file.size > 10 * 1024 * 1024) {
        chunkedUpload(file).catch(function(err) {
          showStatus('✗ 上传失败: ' + err.message, 'error');
        });
      } else {
        // 小文件使用普通上传
        var progress = document.getElementById('progress');
        var progressFill = document.getElementById('progressFill');
        var progressText = document.getElementById('progressText');
        progress.style.display = 'block';
        progressFill.style.width = '0%';
        
        currentXhr = new XMLHttpRequest();
        var formData = new FormData();
        formData.append('file', file);
        
        currentXhr.upload.onprogress = function(evt) {
          if (evt.lengthComputable) {
            var percent = Math.round((evt.loaded / evt.total) * 100);
            progressFill.style.width = percent + '%';
            progressText.textContent = percent + '% (' + formatSize(evt.loaded) + ' / ' + formatSize(evt.total) + ')';
          }
        };
        
        currentXhr.onload = function() {
          progress.style.display = 'none';
          if (currentXhr.status >= 200 && currentXhr.status < 300) {
            showStatus('✓ 上传成功！', 'success');
            setTimeout(function() { location.reload(); }, 1500);
          } else {
            showStatus('✗ 上传失败: ' + currentXhr.status, 'error');
          }
        };
        
        currentXhr.onerror = function() { progress.style.display = 'none'; showStatus('✗ 网络错误', 'error'); };
        currentXhr.onabort = function() { progress.style.display = 'none'; showStatus('✗ 上传已取消', 'error'); };
        currentXhr.ontimeout = function() { progress.style.display = 'none'; showStatus('✗ 上传超时', 'error'); };
        
        currentXhr.open('POST', '/upload');
        currentXhr.timeout = 1800000;
        currentXhr.send(formData);
      }
    }

    document.getElementById('fileInput').onchange = function(e) {
      var file = e.target.files[0];
      startUpload(file);
      e.target.value = '';
    };

    var uploadSection = document.getElementById('uploadSection');
    var dragDepth = 0;

    function hasFiles(dataTransfer) {
      return dataTransfer && Array.prototype.indexOf.call(dataTransfer.types || [], 'Files') !== -1;
    }

    function setDragOver(active) {
      uploadSection.classList.toggle('drag-over', active);
    }

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function(eventName) {
      uploadSection.addEventListener(eventName, function(e) {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
      });
    });

    uploadSection.addEventListener('dragenter', function(e) {
      if (!hasFiles(e.dataTransfer)) return;
      dragDepth++;
      setDragOver(true);
    });

    uploadSection.addEventListener('dragover', function(e) {
      if (!hasFiles(e.dataTransfer)) return;
      e.dataTransfer.dropEffect = 'copy';
    });

    uploadSection.addEventListener('dragleave', function(e) {
      if (!hasFiles(e.dataTransfer)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragOver(false);
    });

    uploadSection.addEventListener('drop', function(e) {
      if (!hasFiles(e.dataTransfer)) return;
      dragDepth = 0;
      setDragOver(false);
      var files = e.dataTransfer.files;
      if (files && files.length > 0) {
        startUpload(files[0]);
      }
    });
    
    function deleteFile(filename) {
      if (!confirm('确定删除 ' + decodeURIComponent(filename) + ' ?')) return;
      fetch('/delete/' + filename, { method: 'DELETE' })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.success) { alert('已删除'); location.reload(); }
          else alert('删除失败: ' + data.error);
        })
        .catch(function(err) { alert('删除失败: ' + err.message); });
    }
  </script>
</body>
</html>`;
  
  res.send(html);
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }

  next(err);
});

app.use((err, req, res, next) => {
  console.error('请求处理失败:', err);
  res.status(500).json({ error: '服务器错误' });
});

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

// 错误处理和进程守护
process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err);
  // 让 PM2 重启进程
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的 Promise 拒绝:', reason);
  // 不退出，继续运行
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 FutureLab 文件共享服务已启动: http://0.0.0.0:${PORT}`);
  console.log(`📦 分片大小: 5MB, 支持断点续传`);
});
