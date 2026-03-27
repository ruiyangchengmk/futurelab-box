const express = require('express');
const multer = require('multer');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const app = express();
const PORT = 8080;
const ACCESS_PASSWORD = 'byd123';
const MAX_STORAGE = 10 * 1024 * 1024 * 1024; // 10GB
const CHUNK_SIZE = 5 * 1024 * 1024; // 每块5MB
const TEMP_DIR = path.join(__dirname, 'temp_chunks');

// 中间件
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());
app.use(express.static('uploads'));

// 确保临时目录存在
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
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
  const ext = path.extname(originalName);
  return `${timestamp}-${random}${ext}`;
}

// 存储配置
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const safeName = generateSafeFilename(file.originalname);
    cb(null, safeName);
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 500 * 1024 * 1024,
    timeout: 1800 * 1000
  }
});

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
  
  const { filename, filesize, chunkSize = CHUNK_SIZE } = req.body;
  if (!filename || !filesize) {
    return res.status(400).json({ error: '缺少参数' });
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
  const chunkDir = path.join(TEMP_DIR, uploadId);
  const infoPath = path.join(chunkDir, 'info.json');
  
  if (!fs.existsSync(infoPath)) {
    return res.status(404).json({ error: '上传不存在或已过期' });
  }
  
  const upload = multer({ storage: multer.memoryStorage() }).any();
  upload(req, res, function(err) {
    if (err) {
      return res.status(500).json({ error: '分片上传失败: ' + err.message });
    }
    
    // 解析 chunkIndex 从 request body
    let chunkIndex = req.body.chunkIndex;
    if (chunkIndex === undefined || chunkIndex === null) {
      return res.status(400).json({ error: '缺少 chunkIndex 参数' });
    }
    chunkIndex = parseInt(chunkIndex, 10);
    
    // 找到上传的文件
    const chunkFile = req.files && req.files.find(f => f.fieldname === 'chunk');
    if (!chunkFile) {
      return res.status(400).json({ error: '没有分片文件' });
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
  const chunkDir = path.join(TEMP_DIR, uploadId);
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
  const chunkDir = path.join(TEMP_DIR, uploadId);
  const infoPath = path.join(chunkDir, 'info.json');
  
  if (!fs.existsSync(infoPath)) {
    return res.status(404).json({ error: '上传不存在或已过期' });
  }
  
  const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  const uploadsDir = path.join(__dirname, 'uploads');
  const safeName = generateSafeFilename(info.originalName);
  const finalPath = path.join(uploadsDir, safeName);
  
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

// 登录验证
function isAuthenticated(req) {
  return req.cookies && req.cookies.authorized === 'true';
}

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
  </style>
</head>
<body>
  <div class="login">
    <h1>FutureLab 文件共享</h1>
    <form id="loginForm">
      <input type="password" id="password" placeholder="请输入密码" required>
      <br>
      <button type="submit">登录</button>
    </form>
  </div>
  <script>
    document.getElementById('loginForm').onsubmit = function(e) {
      e.preventDefault();
      if (document.getElementById('password').value === '${ACCESS_PASSWORD}') {
        document.cookie = 'authorized=true; path=/';
        location.href = '/';
      } else {
        alert('密码错误');
      }
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
  if (password === ACCESS_PASSWORD) {
    res.cookie('authorized', 'true', { maxAge: 24 * 60 * 60 * 1000, path: '/' });
    res.json({ success: true });
  } else {
    res.status(401).json({ error: '密码错误' });
  }
});

app.get('/files', (req, res) => {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: '未登录' });
  }
  
  const uploadsDir = path.join(__dirname, 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    return res.json([]);
  }
  
  const files = fs.readdirSync(uploadsDir).map(filename => {
    const filepath = path.join(uploadsDir, filename);
    const stats = fs.statSync(filepath);
    return {
      name: filename,
      filename: filename,
      size: stats.size,
      date: stats.mtime.toLocaleString('zh-CN')
    };
  });
  
  res.json(files);
});

// 单文件上传（保留小文件快速上传）
app.post('/upload', upload.single('file'), (req, res) => {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: '未登录' });
  }
  
  if (!req.file) {
    return res.status(400).json({ error: '没有文件' });
  }
  
  res.json({ success: true, filename: req.file.filename });
});

app.delete('/delete/:filename', (req, res) => {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: '未登录' });
  }
  
  const filename = req.params.filename;
  const filepath = path.join(__dirname, 'uploads', filename);
  
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  
  try {
    fs.unlinkSync(filepath);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  if (!isAuthenticated(req)) {
    return res.redirect('/login');
  }
  
  const uploadsDir = path.join(__dirname, 'uploads');
  let files = [];
  if (fs.existsSync(uploadsDir)) {
    files = fs.readdirSync(uploadsDir).map(filename => {
      const filepath = path.join(uploadsDir, filename);
      const stats = fs.statSync(filepath);
      return {
        name: filename,
        filename: filename,
        size: formatSize(stats.size),
        date: stats.mtime.toLocaleString('zh-CN')
      };
    });
  }
  
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
    .upload-section { background: rgba(255,255,255,0.05); border: 2px dashed #00d9ff; border-radius: 16px; padding: 40px; text-align: center; margin-bottom: 30px; }
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
    .file-meta { color: #888; font-size: 0.9em; margin-top: 5px; }
    .file-actions { display: flex; gap: 10px; flex-shrink: 0; }
    .btn { padding: 8px 16px; border: none; border-radius: 8px; cursor: pointer; text-decoration: none; font-size: 14px; }
    .btn-download { background: #00d9ff; color: #1a1a2e; }
    .btn-delete { background: #ff4757; color: #fff; }
    #fileInput { display: none; }
    .upload-label { display: inline-block; background: linear-gradient(90deg, #00d9ff, #00ff88); color: #1a1a2e; padding: 15px 40px; border-radius: 30px; cursor: pointer; font-weight: bold; }
    .upload-label:hover { transform: scale(1.05); }
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
    
    <div class="upload-section">
      <h2>上传文件</h2>
      <label for="fileInput" class="upload-label">📤 选择文件</label>
      <input type="file" id="fileInput">
      
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
            <div class="file-name">${f.name}</div>
            <div class="file-meta">${f.size} · ${f.date}</div>
          </div>
          <div class="file-actions">
            <a href="/${encodeURIComponent(f.filename)}" class="btn btn-download" download="${f.name}">⬇️ 下载</a>
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
          completedChunks++;
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
      
      if (completeData.success) {
        showStatus('✓ 上传成功！', 'success');
        setTimeout(function() { location.reload(); }, 1500);
      } else {
        showStatus('✗ ' + completeData.error, 'error');
      }
    }
    
    document.getElementById('fileInput').onchange = function(e) {
      var file = e.target.files[0];
      if (!file) return;
      
      if (currentXhr) currentXhr.abort();
      
      if (!confirm('确认上传: ' + file.name + '\\n大小: ' + formatSize(file.size))) {
        e.target.value = '';
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
    };
    
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
