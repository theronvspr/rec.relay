import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let serverProcess = null;
let mainWindow = null;

function startServer() {
  const env = {
    ...process.env,
    RUNNING_IN_ELECTRON: 'true',
    ELECTRON_USER_DATA: app.getPath('userData'),
    PORT: '3000'
  };

  const cliPath = path.join(__dirname, 'bin', 'cli.js');
  serverProcess = spawn('node', [cliPath], { env });

  serverProcess.stdout.on('data', (data) => {
    console.log(`[Express stdout]: ${data}`);
  });

  serverProcess.stderr.on('data', (data) => {
    console.error(`[Express stderr]: ${data}`);
  });

  serverProcess.on('close', (code) => {
    console.log(`Express server exited with code ${code}`);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'rec.relay',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadURL('http://localhost:3000/dashboard');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  startServer();
  // Wait 1.5 seconds for the Express server to bind and start before opening the window
  setTimeout(createWindow, 1500);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
