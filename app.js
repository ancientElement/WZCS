const statusEl = document.getElementById('status');
const inputEl = document.getElementById('input');
const messageListEl = document.getElementById('messageList');
const encKeyEl = document.getElementById('encKey');
const encBadgeEl = document.getElementById('encBadge');

let clientId = null, eventSource = null, messageStore = [];

// ===== AES-256-CTR =====
function deriveKey(k) {
  const raw = Array.from(k).map(c => c.charCodeAt(0) & 0xff);
  return Array.from({length: 32}, (_, i) => {
    let v = (raw[i % raw.length] ^ (i * 0x6b)) & 0xff;
    v = (v + raw[(i * 7 + 3) % raw.length]) & 0xff;
    return (v ^ raw[(i * 13 + 11) % raw.length]) & 0xff;
  });
}
const toHex = b => b.map(x => x.toString(16).padStart(2, '0')).join('');
const fromHex = h => Array.from({length: h.length / 2}, (_, i) => parseInt(h.substr(i * 2, 2), 16));
const strToBytes = s => Array.from(new TextEncoder().encode(s));
const bytesToStr = b => new TextDecoder().decode(new Uint8Array(b));
const isEncrypted = t => typeof t === 'string' && t.startsWith('\uD83D\uDD12');

function encrypt(plain, keyStr) {
  const iv = Array.from(crypto.getRandomValues(new Uint8Array(16)));
  const ct = new aesjs.ModeOfOperation.ctr(deriveKey(keyStr), new aesjs.Counter(iv)).encrypt(strToBytes(plain));
  return '\uD83D\uDD12' + toHex(iv.concat(Array.from(ct)));
}

function decrypt(cipher, keyStr) {
  try {
    const b = fromHex(cipher.slice('\uD83D\uDD12'.length));
    const pt = new aesjs.ModeOfOperation.ctr(deriveKey(keyStr), new aesjs.Counter(b.slice(0, 16))).decrypt(b.slice(16));
    return bytesToStr(pt);
  } catch { return null; }
}

function processIncoming(raw) {
  const key = encKeyEl.value;
  if (!isEncrypted(raw)) return { text: raw, encrypted: false };
  if (!key) return { text: '\uD83D\uDD12 加密消息，请输入密钥后查看', encrypted: true };
  const plain = decrypt(raw, key);
  return { text: plain ?? '⚠️ 解密失败，密钥不匹配', encrypted: true };
}

// ===== 密钥确认 =====
function confirmKey() {
  encBadgeEl.textContent = encKeyEl.value ? '已加密 \uD83D\uDD12' : '未加密';
  encBadgeEl.className = 'enc-badge' + (encKeyEl.value ? '' : ' off');
  rerenderMessages();
}

// ===== 消息渲染 =====
function rerenderMessages() {
  messageListEl.innerHTML = '';
  if (!messageStore.length) {
    messageListEl.innerHTML = '<div class="empty">暂无消息</div>';
    return;
  }
  messageStore.forEach(entry => {
    const { text, encrypted } = processIncoming(entry.rawText);
    messageListEl.insertBefore(buildItem(text, entry.time, encrypted, entry.isSelf), messageListEl.firstChild);
  });
}

function buildItem(text, time, encrypted, isSelf) {
  const timeStr = new Date(time || Date.now()).toLocaleTimeString('zh-CN');
  const div = document.createElement('div');
  div.className = 'message-item' + (encrypted ? ' encrypted' : '') + (isSelf ? ' self' : '');
  div.innerHTML =
    (isSelf ? '<div class="self-tag">➤ 我发送</div>' : '') +
    (encrypted ? '<div class="enc-tag">\uD83D\uDD12 AES-256 加密消息</div>' : '') +
    `<div class="message-time">${timeStr}</div>` +
    `<div class="message-text">${escapeHtml(text)}</div>`;
  return div;
}

function addMessage(text, time, encrypted, isSelf) {
  messageListEl.querySelector('.empty')?.remove();
  messageListEl.insertBefore(buildItem(text, time, encrypted, isSelf), messageListEl.firstChild);
}

function clearMessages() {
  messageStore = [];
  messageListEl.innerHTML = '<div class="empty">暂无消息</div>';
}

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// ===== SSE =====
function connectSSE() {
  eventSource = new EventSource('/events');
  eventSource.onopen = () => {
    statusEl.textContent = '✓ 已连接 - 可以开始传输文字';
    statusEl.className = 'status connected';
  };
  eventSource.onerror = () => {
    statusEl.textContent = '✗ 连接错误 - 请刷新页面重试';
    statusEl.className = 'status disconnected';
  };
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'connected') {
      clientId = data.clientId;
      loadHistory();
    } else if (data.type === 'message') {
      const rawText = data.data.text;
      messageStore.push({ rawText, time: data.data.time, isSelf: false });
      const { text, encrypted } = processIncoming(rawText);
      addMessage(text, data.data.time, encrypted, false);
    }
  };
}

async function loadHistory() {
  try {
    const messages = await fetch('/messages').then(r => r.json());
    messages.forEach(msg => {
      messageStore.push({ rawText: msg.text, time: msg.time, isSelf: false });
      const { text, encrypted } = processIncoming(msg.text);
      addMessage(text, msg.time, encrypted, false);
    });
  } catch (e) { console.error('加载历史消息失败:', e); }
}

// ===== 发送 =====
async function sendText() {
  const text = inputEl.value.trim();
  if (!text) return alert('请输入要发送的文字');
  if (!clientId) return alert('连接未建立，请刷新页面重试');

  const key = encKeyEl.value;
  const payload = key ? encrypt(text, key) : text;
  try {
    const res = await fetch('/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: payload, clientId })
    });
    if (res.ok) {
      inputEl.value = '';
      const t = new Date().toISOString();
      messageStore.push({ rawText: text, time: t, isSelf: true });
      addMessage(text, t, !!key, true);
      const orig = statusEl.textContent;
      statusEl.textContent = '✓ 发送成功';
      setTimeout(() => statusEl.textContent = orig, 1000);
    } else { alert('发送失败'); }
  } catch (e) { alert('发送失败: ' + e.message); }
}

// ===== 初始化 =====
connectSSE();
inputEl.addEventListener('keydown', e => { if (e.ctrlKey && e.key === 'Enter') sendText(); });
