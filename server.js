import express from 'express';
import readline from 'readline';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import http from 'http';
import os from 'os';
import QRCode from 'qrcode';
import { exec, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_VERSION = '3.4.1';

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

const ALLOWED_MIME = new Set([
  'video/webm',
  'video/mp4',
  'video/quicktime',
]);

const fileFilter = (_req, file, cb) => {
  const baseMime = (file.mimetype || '').split(';')[0].trim();
  if (ALLOWED_MIME.has(baseMime)) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported MIME type: ${file.mimetype}`), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 500 * 1024 * 1024 } // 500 MB
});

// ── Middleware ───────────────────────────────────────────────────────
app.use(express.json());
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// ── SSE (Server-Sent Events) ────────────────────────────────────────
let sseClients = [];
let connectedPeersCount = 0;
let dashboardPeerId = '';

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('data: {"type":"connected"}\n\n');
  sseClients.push(res);
  if (typeof tuiTriggerRedraw === 'function') {
    tuiTriggerRedraw();
  }
  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
    if (sseClients.length === 0) {
      connectedPeersCount = 0;
      dashboardPeerId = '';
    }
    if (typeof tuiTriggerRedraw === 'function') {
      tuiTriggerRedraw();
    }
  });
});

app.post('/api/peers-count', (req, res) => {
  connectedPeersCount = parseInt(req.body.count, 10) || 0;
  if (req.body.peerId) {
    dashboardPeerId = req.body.peerId;
  }
  if (typeof tuiTriggerRedraw === 'function') {
    tuiTriggerRedraw();
  }
  res.json({ success: true });
});

app.post('/api/log', (req, res) => {
  const { level, message } = req.body;
  const logMsg = `[${new Date().toISOString()}] [Browser ${level.toUpperCase()}] ${message}\n`;
  try {
    fs.appendFileSync(path.join(uploadDir, 'headless-browser.log'), logMsg);
  } catch (e) {
    // Ignore
  }
  res.json({ success: true });
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
  res.json({ success: true, localIPs: ips, port: server.address()?.port || PORT });
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

  // Parse metadata from req.body (populated by multer)
  const comment = req.body.comment || '';
  let tags = [];
  try {
    tags = req.body.tags ? JSON.parse(req.body.tags) : [];
  } catch (e) {
    if (typeof req.body.tags === 'string' && req.body.tags) {
      tags = req.body.tags.split(',').map(t => t.trim()).filter(Boolean);
    }
  }
  const musicLink = req.body.musicLink || '';

  // Store in metadata.json
  const meta = readMetadata();
  meta[filename] = {
    tags: Array.isArray(tags) ? tags.map(t => t.trim()).filter(Boolean) : [],
    comment: typeof comment === 'string' ? comment.trim() : '',
    musicLink: typeof musicLink === 'string' ? musicLink.trim() : ''
  };
  writeMetadata(meta);

  broadcast('new_file', { 
    filename, 
    size, 
    createdAt, 
    streamUrl,
    tags: meta[filename].tags,
    comment: meta[filename].comment,
    musicLink: meta[filename].musicLink
  });
  if (typeof tuiTriggerRedraw === 'function') {
    tuiTriggerRedraw();
  }
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

// ── Metadata Storage Helper ──────────────────────────────────────────
const metadataPath = path.join(uploadDir, 'metadata.json');

function readMetadata() {
  try {
    if (fs.existsSync(metadataPath)) {
      return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    }
  } catch (err) {
    console.error('Failed to read metadata.json:', err);
  }
  return {};
}

function writeMetadata(data) {
  try {
    fs.writeFileSync(metadataPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write metadata.json:', err);
  }
}

// ── File list ───────────────────────────────────────────────────────
app.get('/files', (_req, res) => {
  fs.readdir(uploadDir, (err, files) => {
    if (err) return res.status(500).json({ success: false, message: 'Read error.' });
    const metadata = readMetadata();
    const list = files
      .filter(f => f.startsWith('recording-'))
      .map(f => {
        const s = fs.statSync(path.join(uploadDir, f));
        const meta = metadata[f] || {};
        return {
          filename: f,
          size: s.size,
          createdAt: s.birthtime || s.mtime,
          streamUrl: `/stream/${f}`,
          tags: meta.tags || [],
          comment: meta.comment || '',
          musicLink: meta.musicLink || ''
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(list);
  });
});

// ── Save File Metadata ──────────────────────────────────────────────
app.post('/api/files/:filename/metadata', (req, res) => {
  const { filename } = req.params;
  const safePath = path.normalize(path.join(uploadDir, filename));
  if (!safePath.startsWith(path.normalize(uploadDir))) return res.status(403).end();
  if (!fs.existsSync(safePath)) return res.status(404).json({ success: false, message: 'File not found.' });

  const { tags, comment, musicLink } = req.body;
  const meta = readMetadata();
  meta[filename] = {
    tags: Array.isArray(tags) ? tags.map(t => t.trim()).filter(Boolean) : [],
    comment: typeof comment === 'string' ? comment.trim() : '',
    musicLink: typeof musicLink === 'string' ? musicLink.trim() : ''
  };
  writeMetadata(meta);

  broadcast('update_file_metadata', { filename, metadata: meta[filename] });
  if (typeof tuiTriggerRedraw === 'function') {
    tuiTriggerRedraw();
  }
  res.json({ success: true, metadata: meta[filename] });
});

// ── Delete ──────────────────────────────────────────────────────────
app.delete('/files/:filename', (req, res) => {
  const safePath = path.normalize(path.join(uploadDir, req.params.filename));
  if (!safePath.startsWith(path.normalize(uploadDir))) return res.status(403).end();
  if (!fs.existsSync(safePath)) return res.status(404).json({ success: false, message: 'Not found.' });

  fs.unlink(safePath, err => {
    if (err) return res.status(500).json({ success: false, message: 'Delete failed.' });

    // Prune from metadata
    const meta = readMetadata();
    if (meta[req.params.filename]) {
      delete meta[req.params.filename];
      writeMetadata(meta);
    }

    broadcast('delete_file', { filename: req.params.filename });
    if (typeof tuiTriggerRedraw === 'function') {
      tuiTriggerRedraw();
    }
    res.json({ success: true });
  });
});

// ── Interactive CLI Mode ─────────────────────────────────────────────
let tuiTriggerRedraw = null;

function initCliMode(boundPort) {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  let activePane = 'list'; // 'list' or 'calendar'
  let selectedListIndex = 0;
  let selectedCalendarDateStr = ''; // YYYY-MM-DD
  let calendarCursorDate = new Date();
  let showQrOverlay = false;
  let tuiSearchQuery = '';
  let isPromptActive = false;

  function getFriendlySize(bytes) {
    if (!bytes) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
  }

  function getDStr(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function readFilesFromDisk() {
    try {
      const files = fs.readdirSync(uploadDir);
      const metadata = readMetadata();
      return files
        .filter(f => f.startsWith('recording-'))
        .map(f => {
          const s = fs.statSync(path.join(uploadDir, f));
          const meta = metadata[f] || {};
          return {
            filename: f,
            size: s.size,
            createdAt: s.birthtime || s.mtime,
            tags: meta.tags || [],
            comment: meta.comment || '',
            musicLink: meta.musicLink || ''
          };
        })
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    } catch (err) {
      return [];
    }
  }

  function saveMetadataLocally(filename, comment, tags, musicLink) {
    const meta = readMetadata();
    meta[filename] = {
      tags: Array.isArray(tags) ? tags.map(t => t.trim()).filter(Boolean) : [],
      comment: typeof comment === 'string' ? comment.trim() : '',
      musicLink: typeof musicLink === 'string' ? musicLink.trim() : ''
    };
    writeMetadata(meta);
    broadcast('update_file_metadata', { filename, metadata: meta[filename] });
  }

  function deleteFileLocally(filename) {
    const safePath = path.resolve(uploadDir, filename);
    if (!fs.existsSync(safePath)) return;
    try {
      fs.unlinkSync(safePath);
      const meta = readMetadata();
      if (meta[filename]) {
        delete meta[filename];
        writeMetadata(meta);
      }
      broadcast('delete_file', { filename });
    } catch (err) {
      // Ignore
    }
  }

  function makeHyperlink(url, text, visualWidth) {
    const cleanText = text.slice(0, visualWidth);
    const paddedText = cleanText.padEnd(visualWidth);
    return `\u001b]8;;${url}\u0007${paddedText}\u001b]8;;\u0007`;
  }

  function generateAsciiCalendar(cursorDate, selectedDateStr, files, activePane) {
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const year = cursorDate.getFullYear();
    const month = cursorDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const totalDays = new Date(year, month + 1, 0).getDate();
    const todayStr = getDStr(new Date());

    const daysWithRec = new Set(
      files.map(f => getDStr(new Date(f.createdAt)))
    );

    const lines = [];
    const title = `${MONTHS[month]} ${year}`;
    const pad = Math.floor((22 - title.length) / 2);
    lines.push(' '.repeat(Math.max(0, pad)) + `\x1b[1m\x1b[35m${title}\x1b[0m`);
    lines.push(' Su Mo Tu We Th Fr Sa');

    let currentLine = '';
    for (let i = 0; i < firstDay; i++) {
      currentLine += '   ';
    }

    const cursorDateStr = getDStr(cursorDate);

    for (let day = 1; day <= totalDays; day++) {
      const cellDateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      let cell = String(day).padStart(2, ' ');
      
      const isToday = cellDateStr === todayStr;
      const isSelected = cellDateStr === selectedDateStr;
      const isCursor = cellDateStr === cursorDateStr;
      const hasRec = daysWithRec.has(cellDateStr);

      if (isCursor && activePane === 'calendar') {
        cell = `\x1b[46m\x1b[30m${cell}\x1b[0m`;
      } else if (isSelected) {
        cell = `\x1b[43m\x1b[30m${cell}\x1b[0m`;
      } else if (isToday) {
        cell = `\x1b[33m\x1b[4m${cell}\x1b[0m`;
      } else if (hasRec) {
        cell = `\x1b[32m\x1b[1m${cell}\x1b[0m`;
      }

      currentLine += ' ' + cell;

      if ((firstDay + day) % 7 === 0 || day === totalDays) {
        if (day === totalDays) {
          const remaining = 7 - ((firstDay + day) % 7);
          if (remaining < 7) {
            currentLine += '   '.repeat(remaining);
          }
        }
        lines.push(currentLine);
        currentLine = '';
      }
    }
    
    while (lines.length < 8) {
      lines.push(' '.repeat(21));
    }

    return lines;
  }

  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const name in ifaces) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  const ipStr = ips.length ? ips[0] : '127.0.0.1';

  function drawQrScreen() {
    const GITHUB_PAGES_BASE = 'https://theronvspr.github.io/rec.relay';
    let targetUrl = GITHUB_PAGES_BASE;
    if (dashboardPeerId) {
      targetUrl = `${GITHUB_PAGES_BASE}/?peerId=${dashboardPeerId}&v=${APP_VERSION}`;
    }

    process.stdout.write('\x1b[2J\x1b[H');
    console.log('\n  ┌──────────────────────────────────────────────────────────┐');
    console.log('  │                  CONNECT YOUR MOBILE PHONE               │');
    console.log('  └──────────────────────────────────────────────────────────┘\n');

    QRCode.toString(targetUrl, { type: 'terminal', small: true }, (err, qr) => {
      if (!err) {
        console.log(qr);
      } else {
        console.log('  Generating QR Code...');
      }
      console.log(`\n  URL: \x1b[36m${targetUrl}\x1b[0m`);
      console.log('\n  Press \x1b[32m[c]\x1b[0m to close this connection window and return to dashboard.');
    });
  }

  function getVisualLength(str) {
    const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
    const stripped = str
      .replace(ansiRegex, '')
      .replace(/\u001b\]8;;.*?\u0007/g, '')
      .replace(/\u001b\]8;;\u0007/g, '');
    return stripped.length;
  }

  function padVisualEnd(str, targetWidth) {
    const len = getVisualLength(str);
    if (len >= targetWidth) return str;
    return str + ' '.repeat(targetWidth - len);
  }

  function drawScreen() {
    if (showQrOverlay) {
      drawQrScreen();
      return;
    }

    const cols = process.stdout.columns || 80;
    const screenRows = [];
    
    // Connection status badge for header
    let statusBadge = '\x1b[31m[Offline]\x1b[0m';
    if (sseClients.length > 0) {
      statusBadge = connectedPeersCount > 0
        ? `\x1b[32m[${connectedPeersCount} Connected]\x1b[0m`
        : '\x1b[33m[Waiting for phone]\x1b[0m';
    }

    const headerText = `  \x1b[1m\x1b[36mrec.relay\x1b[0m v${APP_VERSION}  ──  Record on mobile, land on PC  `;
    const rightPad = Math.max(0, cols - getVisualLength(statusBadge) - 2);
    screenRows.push(padVisualEnd(headerText, rightPad) + statusBadge);
    screenRows.push('');
    
    const allFiles = readFilesFromDisk();
    let filteredFiles = allFiles;
    if (selectedCalendarDateStr) {
      filteredFiles = filteredFiles.filter(f => getDStr(new Date(f.createdAt)) === selectedCalendarDateStr);
    }
    if (tuiSearchQuery) {
      const query = tuiSearchQuery.toLowerCase();
      filteredFiles = filteredFiles.filter(f => {
        return (f.comment || '').toLowerCase().includes(query) ||
               (f.tags || []).some(t => t.toLowerCase().includes(query));
      });
    }
    
    if (selectedListIndex >= filteredFiles.length) {
      selectedListIndex = Math.max(0, filteredFiles.length - 1);
    }
    
    const calendarLines = generateAsciiCalendar(calendarCursorDate, selectedCalendarDateStr, allFiles, activePane);
    
    const calendarColWidth = 24;
    const dividerCol = ' │ ';
    const tableWidth = cols - calendarColWidth - dividerCol.length - 4;
    
    const colWidthIndex = 5;
    const colWidthSize = 9;
    const colWidthTags = Math.floor(tableWidth * 0.25);
    const colWidthName = Math.max(10, tableWidth - colWidthIndex - colWidthSize - colWidthTags - 6);
    
    const tableHeader = ' ' + 
      'Idx'.padEnd(colWidthIndex) + ' │ ' + 
      'Filename'.padEnd(colWidthName) + ' │ ' + 
      'Size'.padEnd(colWidthSize) + ' │ ' + 
      'Tags';
    const tableDivider = '─'.repeat(tableWidth);
    
    const tableLines = [];
    tableLines.push(tableHeader);
    tableLines.push(tableDivider);
    
    const viewportHeight = 8;
    let startIdx = 0;
    if (selectedListIndex >= startIdx + viewportHeight) {
      startIdx = selectedListIndex - viewportHeight + 1;
    } else if (selectedListIndex < startIdx) {
      startIdx = selectedListIndex;
    }
    
    if (filteredFiles.length === 0) {
      tableLines.push(' '.repeat(Math.max(0, Math.floor((tableWidth - 16) / 2))) + '(No recordings)');
    } else {
      for (let i = startIdx; i < Math.min(filteredFiles.length, startIdx + viewportHeight); i++) {
        const f = filteredFiles[i];
        const isSelected = i === selectedListIndex;
        const isPaneActive = activePane === 'list';
        
        const idxStr = String(i + 1).padEnd(colWidthIndex);
        const sizeStr = getFriendlySize(f.size).padEnd(colWidthSize);
        const tagsStr = (f.tags || []).join(', ').slice(0, colWidthTags).padEnd(colWidthTags);
        
        const absolutePath = path.resolve(uploadDir, f.filename);
        const fileUrl = 'file:///' + absolutePath.replace(/\\/g, '/');
        const nameLink = makeHyperlink(fileUrl, f.filename, colWidthName);
        
        let rowStr = ' ' + idxStr + ' │ ' + nameLink + ' │ ' + sizeStr + ' │ ' + tagsStr;
        
        if (isSelected) {
          if (isPaneActive) {
            rowStr = `\x1b[42m\x1b[30m${rowStr}\x1b[0m`;
          } else {
            rowStr = `\x1b[7m${rowStr}\x1b[0m`;
          }
        }
        tableLines.push(rowStr);
      }
    }
    
    while (tableLines.length < viewportHeight + 2) {
      tableLines.push('');
    }
    
    for (let i = 0; i < Math.max(calendarLines.length, tableLines.length); i++) {
      const calLine = padVisualEnd(calendarLines[i] || '', calendarColWidth);
      const tblLine = tableLines[i] || '';
      screenRows.push(calLine + dividerCol + tblLine);
    }
    
    screenRows.push('');
    
    // Responsive details card layout
    const cardWidth = Math.min(80, cols - 4);
    function formatBoxLine(label, content) {
      const innerContent = label ? `\x1b[1m${label.padEnd(8)}\x1b[0m ${content}` : content;
      const lineWithLeftBorder = `  │  ${innerContent}`;
      return padVisualEnd(lineWithLeftBorder, cardWidth - 1) + '│';
    }

    const selectedFile = filteredFiles[selectedListIndex];
    if (selectedFile) {
      const absolutePath = path.resolve(uploadDir, selectedFile.filename);
      const fileUrl = 'file:///' + absolutePath.replace(/\\/g, '/');
      const streamUrl = `http://localhost:${boundPort}/stream/${selectedFile.filename}`;
      
      const appLink = `\u001b]8;;${fileUrl}\u0007[Open in App / VLC]\u001b]8;;\u0007`;
      const webLink = `\u001b]8;;${streamUrl}\u0007[Stream in Browser]\u001b]8;;\u0007`;
      
      let musicLinkLine = 'None';
      if (selectedFile.musicLink) {
        const musicClickable = `\u001b]8;;${selectedFile.musicLink}\u0007${selectedFile.musicLink}\u001b]8;;\u0007`;
        musicLinkLine = `\x1b[34m${musicClickable}\x1b[0m`;
      }
      
      const tagsLine = selectedFile.tags && selectedFile.tags.length ? selectedFile.tags.map(t => `#${t}`).join(' ') : 'None';
      const commentLine = selectedFile.comment ? `"${selectedFile.comment}"` : 'None';
      
      screenRows.push('  ┌─ SELECTED RECORDING DETAILS ' + '─'.repeat(Math.max(0, cardWidth - 33)) + '┐');
      screenRows.push(formatBoxLine('File:', `\x1b[33m${selectedFile.filename}\x1b[0m`));
      screenRows.push(formatBoxLine('Links:', `\x1b[32m${appLink}\x1b[0m  -or-  \x1b[32m${webLink}\x1b[0m`));
      screenRows.push(formatBoxLine('Date:', new Date(selectedFile.createdAt).toLocaleString()));
      screenRows.push(formatBoxLine('Tags:', `\x1b[36m${tagsLine}\x1b[0m`));
      screenRows.push(formatBoxLine('Music:', musicLinkLine));
      screenRows.push(formatBoxLine('Notes:', `\x1b[37m${commentLine}\x1b[0m`));
      screenRows.push('  └' + '─'.repeat(Math.max(0, cardWidth - 4)) + '┘');
    } else {
      screenRows.push('  ┌─ SELECTED RECORDING DETAILS ' + '─'.repeat(Math.max(0, cardWidth - 33)) + '┐');
      screenRows.push(formatBoxLine('', 'No recording selected.'));
      screenRows.push(formatBoxLine('', ''));
      screenRows.push(formatBoxLine('', ''));
      screenRows.push('  └' + '─'.repeat(Math.max(0, cardWidth - 4)) + '┘');
    }
    
    screenRows.push('');
    
    const serverUrl = `http://${ipStr}:${boundPort}/`;
    
    let filterStatus = 'None';
    if (selectedCalendarDateStr && tuiSearchQuery) {
      filterStatus = `Date: ${selectedCalendarDateStr} + Search: "${tuiSearchQuery}"`;
    } else if (selectedCalendarDateStr) {
      filterStatus = `Date: ${selectedCalendarDateStr}`;
    } else if (tuiSearchQuery) {
      filterStatus = `Search: "${tuiSearchQuery}"`;
    }
    
    screenRows.push(`  \x1b[1mServer URL:\x1b[0m \x1b[36m${serverUrl}\x1b[0m   │   \x1b[1mActive Filter:\x1b[0m \x1b[35m${filterStatus}\x1b[0m`);
    screenRows.push('  ────────────────────────────────────────────────────────────────────────────────');
    screenRows.push('  \x1b[1m[Tab]\x1b[0m Switch Pane   \x1b[1m[Arrows]\x1b[0m Navigate   \x1b[1m[Enter]\x1b[0m Filter Date / Open File');
    screenRows.push('  \x1b[1m[f]\x1b[0m Filter Search   \x1b[1m[c]\x1b[0m QR Code      \x1b[1m[e]\x1b[0m Edit Details   \x1b[1m[d]\x1b[0m Web Dashboard');
    screenRows.push('  \x1b[1m[Del/Backspace]\x1b[0m Delete      \x1b[1m[q]\x1b[0m Quit');
    
    process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(screenRows.join('\n') + '\n');
  }

  function promptSearch() {
    isPromptActive = true;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    process.stdout.write('\x1b[2J\x1b[H');
    rl.question('\n  Search Term (Enter "all" or blank to clear filter): ', (answer) => {
      rl.close();
      process.stdin.resume();
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      
      const query = answer.trim();
      if (!query || query.toLowerCase() === 'all' || query.toLowerCase() === 'all recordings') {
        tuiSearchQuery = '';
      } else {
        tuiSearchQuery = query;
      }
      selectedListIndex = 0;
      isPromptActive = false;
      drawScreen();
    });
  }

  function promptDelete() {
    const allFiles = readFilesFromDisk();
    let filteredFiles = allFiles;
    if (selectedCalendarDateStr) {
      filteredFiles = filteredFiles.filter(f => getDStr(new Date(f.createdAt)) === selectedCalendarDateStr);
    }
    if (tuiSearchQuery) {
      const query = tuiSearchQuery.toLowerCase();
      filteredFiles = filteredFiles.filter(f => {
        return (f.comment || '').toLowerCase().includes(query) ||
               (f.tags || []).some(t => t.toLowerCase().includes(query));
      });
    }
    
    const selFile = filteredFiles[selectedListIndex];
    if (!selFile) return;
    
    isPromptActive = true;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    process.stdout.write('\x1b[2J\x1b[H');
    rl.question(`\n  Are you sure you want to delete ${selFile.filename}? (y/N): `, (answer) => {
      rl.close();
      process.stdin.resume();
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      
      if (answer.trim().toLowerCase() === 'y') {
        deleteFileLocally(selFile.filename);
        selectedListIndex = 0;
      }
      isPromptActive = false;
      drawScreen();
    });
  }

  function promptEditMetadata() {
    const allFiles = readFilesFromDisk();
    let filteredFiles = allFiles;
    if (selectedCalendarDateStr) {
      filteredFiles = filteredFiles.filter(f => getDStr(new Date(f.createdAt)) === selectedCalendarDateStr);
    }
    if (tuiSearchQuery) {
      const query = tuiSearchQuery.toLowerCase();
      filteredFiles = filteredFiles.filter(f => {
        return (f.comment || '').toLowerCase().includes(query) ||
               (f.tags || []).some(t => t.toLowerCase().includes(query));
      });
    }
    
    const selFile = filteredFiles[selectedListIndex];
    if (!selFile) return;
    
    isPromptActive = true;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    process.stdout.write('\x1b[2J\x1b[H');
    console.log(`\n  Editing details for: \x1b[33m${selFile.filename}\x1b[0m\n`);
    
    rl.question(`  Comment [${selFile.comment || 'None'}]: `, (commentAns) => {
      const finalComment = commentAns.trim() !== '' ? commentAns.trim() : (selFile.comment || '');
      
      rl.question(`  Tags (comma-separated) [${(selFile.tags || []).join(', ') || 'None'}]: `, (tagsAns) => {
        let finalTags = selFile.tags || [];
        if (tagsAns.trim() !== '') {
          finalTags = tagsAns.split(',').map(t => t.trim()).filter(Boolean);
        }
        
        rl.question(`  Music Reference Link [${selFile.musicLink || 'None'}]: `, (musicAns) => {
          const finalMusicLink = musicAns.trim() !== '' ? musicAns.trim() : (selFile.musicLink || '');
          
          rl.close();
          process.stdin.resume();
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
          }
          
          saveMetadataLocally(selFile.filename, finalComment, finalTags, finalMusicLink);
          isPromptActive = false;
          drawScreen();
        });
      });
    });
  }

  process.stdin.on('keypress', (str, key) => {
    if (isPromptActive) return;
    if (!key) return;
    
    if (key.ctrl && key.name === 'c') {
      process.exit();
    }
    
    if (showQrOverlay) {
      if (key.name === 'c' || key.name === 'escape') {
        showQrOverlay = false;
        drawScreen();
      } else if (key.name === 'q') {
        process.exit();
      }
      return;
    }
    
    if (key.name === 'tab') {
      activePane = activePane === 'list' ? 'calendar' : 'list';
      drawScreen();
      return;
    }
    
    if (key.name === 'q') {
      console.log('  Shutting down rec.relay. Goodbye!');
      process.exit();
    }
    
    if (key.name === 'd') {
      console.log('  Opening dashboard in browser...');
      openBrowser(`http://localhost:${boundPort}/dashboard`);
      drawScreen();
      return;
    }
    
    if (key.name === 'c') {
      showQrOverlay = true;
      drawScreen();
      return;
    }
    
    if (key.name === 'f') {
      promptSearch();
      return;
    }
    
    if (key.name === 'e') {
      promptEditMetadata();
      return;
    }
    
    if (key.name === 'delete' || key.name === 'backspace') {
      promptDelete();
      return;
    }
    
    if (activePane === 'list') {
      const allFiles = readFilesFromDisk();
      let filteredFiles = allFiles;
      if (selectedCalendarDateStr) {
        filteredFiles = filteredFiles.filter(f => getDStr(new Date(f.createdAt)) === selectedCalendarDateStr);
      }
      if (tuiSearchQuery) {
        const query = tuiSearchQuery.toLowerCase();
        filteredFiles = filteredFiles.filter(f => {
          return (f.comment || '').toLowerCase().includes(query) ||
                 (f.tags || []).some(t => t.toLowerCase().includes(query));
        });
      }
      
      if (key.name === 'up') {
        if (selectedListIndex > 0) {
          selectedListIndex--;
          drawScreen();
        }
      } else if (key.name === 'down') {
        if (selectedListIndex < filteredFiles.length - 1) {
          selectedListIndex++;
          drawScreen();
        }
      } else if (key.name === 'return' || key.name === 'enter') {
        const selFile = filteredFiles[selectedListIndex];
        if (selFile) {
          const streamUrl = `http://localhost:${boundPort}/stream/${selFile.filename}`;
          openBrowser(streamUrl);
        }
      }
    } else if (activePane === 'calendar') {
      if (key.name === 'left') {
        calendarCursorDate.setDate(calendarCursorDate.getDate() - 1);
        drawScreen();
      } else if (key.name === 'right') {
        calendarCursorDate.setDate(calendarCursorDate.getDate() + 1);
        drawScreen();
      } else if (key.name === 'up') {
        calendarCursorDate.setDate(calendarCursorDate.getDate() - 7);
        drawScreen();
      } else if (key.name === 'down') {
        calendarCursorDate.setDate(calendarCursorDate.getDate() + 7);
        drawScreen();
      } else if (key.name === 'return' || key.name === 'enter') {
        const cursorDStr = getDStr(calendarCursorDate);
        if (selectedCalendarDateStr === cursorDStr) {
          selectedCalendarDateStr = '';
        } else {
          selectedCalendarDateStr = cursorDStr;
        }
        selectedListIndex = 0;
        drawScreen();
      }
    }
  });

  process.stdout.on('resize', () => {
    drawScreen();
  });

  tuiTriggerRedraw = () => {
    drawScreen();
  };

  drawScreen();
}

// ── Auto-open browser ───────────────────────────────────────────────
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const full = process.platform === 'win32' ? `${cmd} "" "${url}"` : `${cmd} "${url}"`;
  exec(full, err => { if (err) console.error(`Auto-open failed: ${err.message}`); });
};

let headlessBrowserProcess = null;

function findSystemBrowser() {
  const platform = process.platform;
  const paths = [];

  if (platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'] || path.join(process.env['USERPROFILE'] || 'C:\\Users\\Default', 'AppData\\Local');

    paths.push(
      path.join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(programFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(programFiles, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(programFiles, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      path.join(programFilesX86, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe')
    );
  } else if (platform === 'darwin') {
    paths.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
    );
  } else {
    paths.push(
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/brave-browser',
      '/usr/bin/brave'
    );
  }

  for (const p of paths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

function startHeadlessBrowser(port) {
  const browserPath = findSystemBrowser();
  if (!browserPath) {
    return;
  }

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-ipc-flooding-protection',
    '--no-sandbox',
    `http://localhost:${port}/cli-receiver.html`
  ];

  try {
    const logPath = path.join(uploadDir, 'headless-browser.log');
    const logFd = fs.openSync(logPath, 'a');
    fs.writeSync(logFd, `\n--- Headless Browser Session Start: ${new Date().toISOString()} ---\n`);

    headlessBrowserProcess = spawn(browserPath, args, { stdio: ['ignore', logFd, logFd], detached: false });
    
    headlessBrowserProcess.on('error', (err) => {
      console.error('Headless browser failed to start:', err.message);
    });

    headlessBrowserProcess.on('exit', () => {
      headlessBrowserProcess = null;
    });
  } catch (err) {
    console.error('Failed to spawn headless browser:', err);
  }
}

function setupExitHandlers() {
  const cleanExit = () => {
    if (headlessBrowserProcess) {
      try {
        headlessBrowserProcess.kill();
      } catch (e) {
        // Ignore
      }
      headlessBrowserProcess = null;
    }
    process.exit();
  };

  process.on('SIGINT', cleanExit);
  process.on('SIGTERM', cleanExit);
  process.on('SIGHUP', cleanExit);
  process.on('exit', () => {
    if (headlessBrowserProcess) {
      try {
        headlessBrowserProcess.kill();
      } catch (e) {
        // Ignore
      }
    }
  });
}

// ── Global error handler ────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, error: 'File too large. Maximum is 500 MB.' });
  }
  if (err.message?.startsWith('Unsupported MIME')) {
    return res.status(415).json({ success: false, error: err.message });
  }
  console.error('[Server Error]', err.message);
  res.status(500).json({ success: false, error: 'Internal server error.' });
});

// ── Start server ────────────────────────────────────────────────────
const server = http.createServer(app);

let currentTryPort = PORT;

function startServer(port) {
  currentTryPort = port;
  server.listen(port, HOST);
}

server.on('listening', () => {
  const boundPort = server.address().port;
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name in ifaces) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }

  if (process.env.RUNNING_AS_CLI === 'true' && process.env.RUNNING_IN_ELECTRON !== 'true') {
    setupExitHandlers();
    startHeadlessBrowser(boundPort);
    initCliMode(boundPort);
    return;
  }

  console.log('');
  console.log('  rec.relay');
  console.log('  record on mobile, land on PC');
  console.log('  ─────────────────────────────');
  console.log(`  Dashboard:  http://localhost:${boundPort}/dashboard`);
  if (ips.length) {
    console.log(`  LAN IP:     ${ips[0]}`);

    QRCode.toString(`http://localhost:${boundPort}/dashboard`, { type: 'terminal', small: true }, (err, qr) => {
      if (!err) { console.log(''); console.log(qr); }
      console.log('');
    });
  } else {
    console.log('');
  }

  if (!process.env.RUNNING_IN_ELECTRON) {
    openBrowser(`http://localhost:${boundPort}/dashboard`);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const nextPort = parseInt(currentTryPort, 10) + 1;
    console.log(`Port ${currentTryPort} is busy. Trying port ${nextPort}...`);
    startServer(nextPort);
  } else {
    console.error('Server error:', err);
  }
});

startServer(currentTryPort);
