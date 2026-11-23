const { app, BrowserWindow, dialog, Menu, Tray } = require('electron');
const { randomBytes } = require('node:crypto');
const path = require('node:path');

const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.ico')
  : path.join(__dirname, 'build', 'icon.ico');
const startMinimized = process.argv.includes('--minimized');
const resetPinAtStartup = process.argv.includes('--reset-pin');
let mainWindow;
let tray;
let server;
let quitting = false;

if (resetPinAtStartup) process.env.RESET_ADMIN_PIN = '1';

async function openPage(page = '/admin') {
  if (!mainWindow) createWindow();
  await mainWindow.loadURL(`http://127.0.0.1:${Number(process.env.PORT) || 3000}${page}`);
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  if (mainWindow) return;
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 850,
    minWidth: 360,
    minHeight: 600,
    icon: iconPath,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  mainWindow.on('ready-to-show', () => {
    if (!startMinimized) mainWindow.show();
  });
  mainWindow.on('close', event => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(`http://127.0.0.1:${Number(process.env.PORT) || 3000}/admin`);
}

async function resetAdminPin() {
  const { response } = await dialog.showMessageBox(mainWindow || undefined, {
    type: 'warning',
    buttons: ['Reset PIN', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Reset the Admin PIN?',
    detail: 'The next visit to Admin will prompt you to create a new PIN.'
  });
  if (response !== 0) return;
  const result = await fetch(`http://127.0.0.1:${Number(process.env.PORT) || 3000}/api/local/reset-pin`, {
    method: 'POST'
  });
  if (!result.ok) throw new Error((await result.json()).error || 'Could not reset the Admin PIN.');
  if (mainWindow) await openPage('/admin');
  else tray.displayBalloon?.({ title: 'Pick What We Watch', content: 'Admin PIN reset. Set a new PIN next time you open Admin.' });
}

function createTray() {
  tray = new Tray(iconPath);
  tray.setToolTip('Pick What We Watch');
  const loginSettings = process.platform === 'win32' ? app.getLoginItemSettings() : {};
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Admin', click: () => openPage('/admin') },
    { label: 'Open Vote', click: () => openPage('/vote') },
    { type: 'separator' },
    {
      label: 'Start Minimized on Boot',
      type: 'checkbox',
      checked: Boolean(loginSettings.openAtLogin),
      click: item => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          args: item.checked ? ['--minimized'] : []
        });
      }
    },
    {
      label: 'Reset Admin PIN',
      click: () => resetAdminPin().catch(error =>
        dialog.showErrorBox('Could not reset Admin PIN', error.message))
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('double-click', () => openPage('/admin'));
}

async function startApp() {
  process.env.DATA_DIR = app.getPath('userData');
  process.env.SESSION_SECRET ||= randomBytes(32).toString('hex');

  const { startServer } = require('./server');
  const port = Number(process.env.PORT) || 3000;
  server = startServer(port);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  createTray();
  createWindow();
}

app.whenReady().then(startApp).catch(error => {
  dialog.showErrorBox('Pick What We Watch could not start', error.message);
  app.quit();
});

app.on('activate', () => openPage('/admin'));
app.on('before-quit', () => {
  quitting = true;
  if (server?.listening) server.close();
});
