const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;

// 存储消息和客户端
let messages = [];
let clients = [];
let clientIdCounter = 0;

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

  // 发送消息
  if (req.url === '/send' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const text = data.text;
        const senderId = data.clientId;
        
        if (!text || !text.trim()) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: '消息不能为空' }));
          return;
        }

        const message = {
          id: Date.now(),
          text: text.trim(),
          time: new Date().toISOString(),
          senderId: senderId
        };

        // 保存消息
        messages.push(message);
        // 只保留最近100条
        if (messages.length > 100) {
          messages = messages.slice(-100);
        }

        console.log(`收到来自设备 ${senderId} 的消息:`, text.substring(0, 50) + (text.length > 50 ? '...' : ''));

        // 广播给所有其他客户端
        clients.forEach(client => {
          if (client.id !== senderId) {
            client.res.write(`data: ${JSON.stringify({ type: 'message', data: message })}

`);
          }
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '无效的请求数据' }));
      }
    });
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
