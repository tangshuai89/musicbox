import { app, BrowserWindow, shell } from 'electron';
import * as path from 'path';

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    minWidth: 360,
    minHeight: 520,
    maxWidth: 500,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#fafaf9',
    resizable: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    const rendererPath = path.join(process.resourcesPath, 'renderer', 'index.html');
    mainWindow.loadFile(rendererPath);
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // On macOS, keep the app running when all windows are closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
