import { app, BrowserWindow, dialog } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let serverProcess = null;
let mainWindow = null;
let customPort = '3000'; // Default start port

function killProcessOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const output = execSync(`netstat -ano | findstr :${port}`).toString();
      const lines = output.trim().split('\n');
      const listeningLine = lines.find(l => l.includes('LISTENING'));
      if (listeningLine) {
        const parts = listeningLine.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        execSync(`taskkill /F /PID ${pid}`);
        console.log(`Killed process ${pid} on port ${port}`);
        return true;
      }
    } else {
      const pid = execSync(`lsof -t -i:${port}`).toString().trim();
      if (pid) {
        execSync(`kill -9 ${pid}`);
        console.log(`Killed process ${pid} on port ${port}`);
        return true;
      }
    }
  } catch (err) {
    console.error(`No process found or failed to kill process on port ${port}:`, err.message);
  }
  return false;
}

function startServer(portToUse) {
  customPort = String(portToUse);
  const env = {
    ...process.env,
    RUNNING_IN_ELECTRON: 'true',
    ELECTRON_USER_DATA: app.getPath('userData'),
    PORT: customPort
  };

  const cliPath = path.join(__dirname, 'bin', 'cli.js');
  serverProcess = spawn('node', [cliPath], { env });

  serverProcess.stdout.on('data', (data) => {
    const text = data.toString();
    console.log(`[Express stdout]: ${text}`);

    // Dynamic port detection: wait for Express to print its dashboard link and extract the port
    const match = text.match(/Dashboard:\s+http:\/\/localhost:(\d+)\/dashboard/);
    if (match) {
      const boundPort = match[1];
      customPort = boundPort; // Update the tracking port
      console.log(`Express server confirmed listening on port ${boundPort}. Creating window.`);
      createWindow(boundPort);
    }
  });

  serverProcess.stderr.on('data', (data) => {
    console.error(`[Express stderr]: ${data}`);
  });

  serverProcess.on('close', (code) => {
    console.log(`Express server exited with code ${code}`);
  });
}

function createWindow(port) {
  if (mainWindow) return; // Window already exists
  
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

  mainWindow.loadURL(`http://localhost:${port}/dashboard`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function initializeApp(portToUse) {
  startServer(portToUse);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(customPort);
    }
  });
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  // Another instance is already running. Defer dialog box until ready.
  app.whenReady().then(() => {
    const choice = dialog.showMessageBoxSync({
      type: 'question',
      buttons: ['Focus Existing App', 'Stop Existing & Start on 3000', 'Run on a Different Port'],
      defaultId: 0,
      title: 'rec.relay',
      message: 'Another instance of rec.relay is already running.',
      detail: 'What would you like to do?'
    });

    if (choice === 0) {
      app.quit();
    } else if (choice === 1) {
      killProcessOnPort(3000);
      // Give the OS 1 second to release the port
      setTimeout(() => {
        initializeApp(3000);
      }, 1000);
    } else {
      // Isolate this instance's userData directory to avoid LevelDB locks
      const newUserData = path.join(app.getPath('userData'), `instance-${Date.now()}`);
      app.setPath('userData', newUserData);
      initializeApp(3001);
    }
  });
} else {
  // First instance behavior
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => initializeApp(3000));
}

app.on('window-all-closed', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
