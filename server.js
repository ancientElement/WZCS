const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const MAX_IMAGE_MEMORY = 30 * 1024 * 1024; // 30MB

// 存储消息、图片和客户端
let messages = [];
let images = new Map(); // id -> { data: base64, size: bytes, time }
let totalImageSize = 0;
let clients = [];
let clientIdCounter = 0;

// 清理最旧的图片直到满足内存限制
function cleanupImages() {
  while (totalImageSize > MAX_IMAGE_MEMORY && images.size > 0) {
    const oldest = [...images.entries()].sort((a, b) => new Date(a[1].time) - new Date(b[1].time))[0];
    if (oldest) {
      totalImageSize -= oldest[1].size;
      images.delete(oldest[0]);
    }
  }
}

// 创建 HTTP 服务器
const server = http.createServer((req, res) => {
  // 设置 CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 主页
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    return;
  }

  // 静态文件
  const staticFiles = { '/aes.js': 'aes.js', '/app.js': 'app.js', '/style.css': 'style.css' };
  if (req.method === 'GET' && staticFiles[req.url]) {
    const ext = req.url.split('.').pop();
    const mime = ext === 'css' ? 'text/css' : 'application/javascript';
    res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, staticFiles[req.url])));
    return;
  }

  // SSE 长连接 - 接收消息
  if (req.url === '/events' && req.method === 'GET') {
    const clientId = ++clientIdCounter;
    
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    // 发送客户端ID
    res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}

`);

    // 保存客户端连接
    const client = { id: clientId, res };
    clients.push(client);
    console.log(`设备 ${clientId} 已连接`);

    // 清理断开连接的客户端
    req.on('close', () => {
      clients = clients.filter(c => c.id !== clientId);
      console.log(`设备 ${clientId} 已断开`);
    });

    return;
  }

  // 发送消息或图片
  if (req.url === '/send' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const senderId = data.clientId;
        const isImage = data.type === 'image';
        
        if (isImage) {
          const imageData = data.imageData;
          const imageSize = Buffer.byteLength(imageData, 'utf8');
          
          if (!imageData || imageSize === 0) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: '图片数据不能为空' }));
            return;
          }
          
          while (totalImageSize + imageSize > MAX_IMAGE_MEMORY && images.size > 0) {
            const oldest = [...images.entries()].sort((a, b) => new Date(a[1].time) - new Date(b[1].time))[0];
            if (oldest) {
              totalImageSize -= oldest[1].size;
              images.delete(oldest[0]);
            } else break;
          }
          
          const imageId = 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
          images.set(imageId, { data: imageData, size: imageSize, time: new Date().toISOString() });
          totalImageSize += imageSize;
          
          const message = {
            id: Date.now(),
            type: 'image',
            imageId: imageId,
            time: new Date().toISOString(),
            senderId: senderId
          };
          
          messages.push(message);
          if (messages.length > 100) messages = messages.slice(-100);
          
          console.log(`收到来自设备 ${senderId} 的图片: ${(imageSize/1024).toFixed(1)}KB, 总图片内存: ${(totalImageSize/1024/1024).toFixed(2)}MB`);
          
          clients.forEach(client => {
            if (client.id !== senderId) {
              client.res.write(`data: ${JSON.stringify({ type: 'message', data: message })}\n\n`);
            }
          });
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, imageId }));
          
        } else {
          const text = data.text;
          if (!text || !text.trim()) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: '消息不能为空' }));
            return;
          }

          const message = {
            id: Date.now(),
            type: 'text',
            text: text.trim(),
            time: new Date().toISOString(),
            senderId: senderId
          };

          messages.push(message);
          if (messages.length > 100) messages = messages.slice(-100);

          console.log(`收到来自设备 ${senderId} 的消息:`, text.substring(0, 50) + (text.length > 50 ? '...' : ''));

          clients.forEach(client => {
            if (client.id !== senderId) {
              client.res.write(`data: ${JSON.stringify({ type: 'message', data: message })}\n\n`);
            }
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        }
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '无效的请求数据' }));
      }
    });
    return;
  }

  // 获取图片
  if (req.url.startsWith('/image/') && req.method === 'GET') {
    const imageId = req.url.slice(7);
    const img = images.get(imageId);
    if (img) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ imageData: img.data }));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: '图片不存在或已过期' }));
    }
    return;
  }

  // 获取历史消息
  if (req.url === '/messages' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(messages.slice(-20)));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// 获取本机 IP 地址
// 获取本机所有 IP 地址
function getLocalIPs() {
    try {
        const os = require('os');
        const interfaces = os.networkInterfaces();
        const ips = [];
        
        if (!interfaces || typeof interfaces !== 'object') {
            return ['localhost'];
        }
        
        for (const name of Object.keys(interfaces)) {
            try {
                const ifaceArray = interfaces[name];
                if (!Array.isArray(ifaceArray)) continue;
                
                for (const iface of ifaceArray) {
                    try {
                        const family = iface.family;
                        const isIPv4 = family === 'IPv4' || family === 4;
                        if (isIPv4 && !iface.internal && iface.address) {
                            ips.push(iface.address);
                        }
                    } catch (e) {
                        continue;
                    }
                }
            } catch (e) {
                continue;
            }
        }
        
        return ips.length > 0 ? ips : ['localhost'];
    } catch (err) {
        return ['localhost'];
    }
}
const localIPs = getLocalIPs();
server.listen(PORT, () => {
    console.log('\n========================================');
    console.log('  局域网文字传输工具已启动！');
    console.log('========================================');
    console.log(`\n请用浏览器访问以下地址之一：`);
    localIPs.forEach(ip => {
        console.log(`  • http://${ip}:${PORT}`);
    });
    console.log('\n在同一局域网的手机/电脑上打开上述地址即可互传文字');
    console.log('========================================\n');
});
