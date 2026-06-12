import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import http from 'http';
import os from 'os';
import QRCode from 'qrcode';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_VERSION = '3.0.0';

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '127.0.0.1'; // Bind to loopback only — no firewall rules needed

let uploadDir = path.join(__dirname, 'uploads');
if (process.env.RUNNING_IN_ELECTRON && process.env.ELECTRON_USER_DATA) {
  uploadDir = path.join(process.env.ELECTRON_USER_DATA, 'uploads');
} else {
  uploadDir = path.resolve(process.cwd(), 'uploads');
}

// Ensure upload directory exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// ── Multer storage ──────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.webm';
    cb(null, `recording-${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500 MB
});

// ── Middleware ───────────────────────────────────────────────────────
app.use(express.json());
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// ── SSE (Server-Sent Events) ────────────────────────────────────────
let sseClients = [];

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('data: {"type":"connected"}\n\n');
  sseClients.push(res);
  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

function broadcast(type, data) {
  const payload = JSON.stringify({ type, data });
  sseClients.forEach(c => c.write(`data: ${payload}\n\n`));
}

// ── API: QR code generator ──────────────────────────────────────────
app.get('/api/qrcode', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ success: false, message: 'url query param required' });
  try {
    const qr = await QRCode.toDataURL(url, { margin: 2, width: 280 });
    res.json({ success: true, qrCode: qr });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── API: Server info (LAN IPs) ─────────────────────────────────────
app.get('/api/server-info', (_req, res) => {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name in ifaces) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  res.json({ success: true, localIPs: ips, port: PORT });
});

// ── API: Check for updates via GitHub ──────────────────────────────
app.get('/api/check-update', async (_req, res) => {
  try {
    const response = await fetch('https://api.github.com/repos/theronvspr/rec.relay/releases/latest', {
      headers: { 'User-Agent': 'rec.relay-app' }
    });
    if (response.status === 404) {
      return res.json({ success: true, latestVersion: null, currentVersion: APP_VERSION });
    }
    if (!response.ok) {
      throw new Error(`GitHub API returned status ${response.status}`);
    }
    const data = await response.json();
    const latestVersion = data.tag_name ? data.tag_name.replace(/^v/, '') : '';
    res.json({ success: true, latestVersion, currentVersion: APP_VERSION });
  } catch (err) {
    console.error('Update check failed:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Pages ───────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(publicDir, 'dashboard.html')));

// ── Upload ──────────────────────────────────────────────────────────
app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No video file received.' });

  const { filename, size } = req.file;
  const createdAt = new Date().toISOString();
  const streamUrl = `/stream/${filename}`;

  broadcast('new_file', { filename, size, createdAt, streamUrl });
  res.json({ success: true, filename, streamUrl });
});

// ── Stream (Range requests) ─────────────────────────────────────────
app.get('/stream/:filename', (req, res) => {
  const safePath = path.normalize(path.join(uploadDir, req.params.filename));
  if (!safePath.startsWith(path.normalize(uploadDir))) return res.status(403).end();
  if (!fs.existsSync(safePath)) return res.status(404).json({ success: false, message: 'Not found.' });

  const stat = fs.statSync(safePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  const ext = path.extname(safePath);
  const contentType = ext === '.mp4' ? 'video/mp4' : ext === '.mov' ? 'video/quicktime' : 'video/webm';

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    if (start >= fileSize) { res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` }); return res.end(); }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': contentType
    });
    fs.createReadStream(safePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(safePath).pipe(res);
  }
});

// ── File list ───────────────────────────────────────────────────────
app.get('/files', (_req, res) => {
  fs.readdir(uploadDir, (err, files) => {
    if (err) return res.status(500).json({ success: false, message: 'Read error.' });
    const list = files
      .filter(f => f.startsWith('recording-'))
      .map(f => {
        const s = fs.statSync(path.join(uploadDir, f));
        return { filename: f, size: s.size, createdAt: s.birthtime || s.mtime, streamUrl: `/stream/${f}` };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(list);
  });
});

// ── Delete ──────────────────────────────────────────────────────────
app.delete('/files/:filename', (req, res) => {
  const safePath = path.normalize(path.join(uploadDir, req.params.filename));
  if (!safePath.startsWith(path.normalize(uploadDir))) return res.status(403).end();
  if (!fs.existsSync(safePath)) return res.status(404).json({ success: false, message: 'Not found.' });

  fs.unlink(safePath, err => {
    if (err) return res.status(500).json({ success: false, message: 'Delete failed.' });
    broadcast('delete_file', { filename: req.params.filename });
    res.json({ success: true });
  });
});

// ── Auto-open browser ───────────────────────────────────────────────
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const full = process.platform === 'win32' ? `${cmd} "" "${url}"` : `${cmd} "${url}"`;
  exec(full, err => { if (err) console.error(`Auto-open failed: ${err.message}`); });
}

// ── Start server ────────────────────────────────────────────────────
const server = http.createServer(app);

server.listen(PORT, HOST, () => {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name in ifaces) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }

  console.log('');
  console.log('  rec.relay');
  console.log('  record on mobile, land on PC');
  console.log('  ─────────────────────────────');
  console.log(`  Dashboard:  http://localhost:${PORT}/dashboard`);
  if (ips.length) {
    console.log(`  LAN IP:     ${ips[0]}`);

    QRCode.toString(`http://localhost:${PORT}/dashboard`, { type: 'terminal', small: true }, (err, qr) => {
      if (!err) { console.log(''); console.log(qr); }
    });
  }
  console.log('');

  if (!process.env.RUNNING_IN_ELECTRON) {
    openBrowser(`http://localhost:${PORT}/dashboard`);
  }
});
