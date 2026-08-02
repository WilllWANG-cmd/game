const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { PartyManager } = require('./party');

// 存档目录：放在用户 Documents 下的 PixelCitySurvival/saves
function getSavesDir() {
  const base = app.getPath('documents');
  const dir = path.join(base, 'PixelCitySurvival', 'saves');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    title: '像素城市求生',
    backgroundColor: '#0a0a12',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // 拦截 F12：阻止默认打开 DevTools，并通过 IPC 通知渲染端切换"开发者模式"
  // 注意：before-input-event 的 preventDefault 会阻止事件派发到页面，
  //       所以这里不能让页面自己监听 F12，而是主进程发消息过去。
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      event.preventDefault();
      mainWindow.webContents.send('dev:toggle');
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- 存档 IPC ----------
ipcMain.handle('save:list', async () => {
  const dir = getSavesDir();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const saves = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
      const data = JSON.parse(raw);
      saves.push({
        id: data.id,
        name: data.name,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        playtime: data.playtime || 0,
        hp: data.player ? data.player.hp : null,
        maxHp: data.player ? data.player.maxHp : null,
        kills: data.stats ? data.stats.kills : 0,
        scene: data.scene
      });
    } catch (e) {
      // 跳过损坏的存档
    }
  }
  saves.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return saves;
});

ipcMain.handle('save:load', async (event, id) => {
  const dir = getSavesDir();
  const file = path.join(dir, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return null;
  }
});

ipcMain.handle('save:write', async (event, payload) => {
  const dir = getSavesDir();
  const file = path.join(dir, `${payload.id}.json`);
  payload.updatedAt = Date.now();
  if (!payload.createdAt) payload.createdAt = payload.updatedAt;
  // 异步写、去掉 pretty-print，减少卡顿与体积
  await fs.promises.writeFile(file, JSON.stringify(payload), 'utf-8');
  return { ok: true, updatedAt: payload.updatedAt };
});

ipcMain.handle('save:delete', async (event, id) => {
  const dir = getSavesDir();
  const file = path.join(dir, `${id}.json`);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    return { ok: true };
  }
  return { ok: false };
});

ipcMain.handle('dialog:confirm', async (event, message) => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['确定', '取消'],
    defaultId: 0,
    cancelId: 1,
    title: '确认',
    message
  });
  return result.response === 0;
});

// ---------- 派对 / 联机 ----------
const party = new PartyManager(() => mainWindow);

ipcMain.handle('party:hostStart', async (event, args) => {
  try { return { ok: true, data: await party.hostStart(args || {}) }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

ipcMain.handle('party:join', async (event, args) => {
  try { return { ok: true, data: await party.join(args || {}) }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

ipcMain.handle('party:leave', async () => { party.leave(); return { ok: true }; });

ipcMain.handle('party:state', async () => party.getState());

ipcMain.handle('party:discover', async () => {
  // 确保发现 socket 在跑
  if (!party.discListening) party.startDiscovery();
  return party.discoverList();
});

ipcMain.handle('party:send', async (event, obj) => {
  if (party.role === 'host') party.hostBroadcast(obj);
  else if (party.role === 'client') party.clientSend(obj);
  return { ok: true };
});

ipcMain.handle('party:hostBroadcast', async (event, obj) => {
  if (party.role === 'host') party.hostBroadcast(obj);
  return { ok: true };
});

ipcMain.handle('party:hostSendTo', async (event, { clientId, obj }) => {
  if (party.role === 'host') party.hostSendTo(clientId, obj);
  return { ok: true };
});

ipcMain.handle('party:hostSetSceneLabel', async (event, label) => {
  party.hostSetSceneLabel(label);
  return { ok: true };
});

