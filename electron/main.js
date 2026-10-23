'use strict';
// Nightshift 桌面版（浅色外观时叫 Dayshift）：在程序里直接启动本地服务（server/），用原生窗口显示界面。
// 和浏览器版用的是同一套界面和服务，只是多了原生的选文件夹对话框、桌面通知、关闭前提醒，安装版还会自动更新（updater.js）。
const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, nativeTheme, screen, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
// 对话框和右键菜单的文字跟着设置里的语言（和服务端共用一套词典）
const { t: tr, setLang } = require('../server/i18n');
const updater = require('./updater');

const APP_ID = 'com.agentchat.desktop';
const PORT = 37210; // 固定端口：界面里的草稿和上次打开的项目存在浏览器存储里，端口变了就找不回来
const IS_MAC = process.platform === 'darwin';
// 沉浸式标题栏：不要系统标题栏，最小化 / 最大化 / 关闭按钮由系统画在界面右上角（颜色由界面告诉我们）
const TITLEBAR_H = 40;
const titleBarColors = () =>
  nativeTheme.shouldUseDarkColors ? { color: '#111111', symbolColor: '#c8c8c8' } : { color: '#f4f5f7', symbolColor: '#3a4049' };
// 右侧面板里的浏览器：单独的存储分区，和 Agent Chat 自己的界面隔开
const BROWSER_PARTITION = 'persist:agentchat-browser';

app.setAppUserModelId(APP_ID); // Windows 通知需要
// 数据还放在原来的「Agent Chat」文件夹里（改名前的版本也在这里），升级后项目和聊天记录都还在。
// AGENT_CHAT_USER_DATA 只在测试时用：换一个配置目录，就不会和正在使用的这个程序抢「只能开一个」的锁
app.setPath('userData', process.env.AGENT_CHAT_USER_DATA || path.join(app.getPath('appData'), 'Agent Chat'));

// 深色外观叫 Nightshift（月亮图标），浅色叫 Dayshift（太阳图标）。exe 和开始菜单里的图标是固定的 Nightshift，
// 运行中的窗口和任务栏图标跟着外观换（图标由 scripts/make-icon.js 生成）
const brand = () => (nativeTheme.shouldUseDarkColors ? { name: 'Nightshift', icon: 'icon' } : { name: 'Dayshift', icon: 'icon-day' });
const appName = () => brand().name;
function iconPath() {
  const f = path.join(__dirname, '..', 'build', brand().icon + (process.platform === 'win32' ? '.ico' : '.png'));
  return fs.existsSync(f) ? f : undefined;
}
nativeTheme.on('updated', () => {
  const icon = iconPath();
  if (win && !win.isDestroyed() && icon && win.setIcon) win.setIcon(icon);
});

let win = null;
let srv = null;
let updates = null; // 自动更新（updater.js）
let quitting = false;

// ---------- 窗口位置和大小 ----------
const boundsFile = () => path.join(app.getPath('userData'), 'window.json');

function loadBounds() {
  const def = { width: 1280, height: 820 };
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
    // 上次的位置要还在某块屏幕上才用，免得窗口跑到看不见的地方
    const area = screen.getDisplayMatching(b).workArea;
    const visible = b.x + 100 > area.x && b.y + 50 > area.y && b.x < area.x + area.width - 100 && b.y < area.y + area.height - 50;
    return visible ? b : { ...def, maximized: b.maximized };
  } catch {
    return def;
  }
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(boundsFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch {}
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function openExternal(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}

// 还有成员在工作时先问一声（关窗口、重启更新都会停掉它们）。返回 true 表示用户同意
function confirmStop(okLabel, detail) {
  const choice = dialog.showMessageBoxSync(win, {
    type: 'question',
    buttons: [okLabel, tr('取消')],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: appName(),
    message: tr('还有 AI 成员在工作'),
    detail,
  });
  return choice === 0;
}

async function createWindow() {
  const b = loadBounds();
  win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: appName(),
    icon: iconPath(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111111' : '#f4f5f7',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    ...(IS_MAC ? { trafficLightPosition: { x: 14, y: 13 } } : { titleBarOverlay: { ...titleBarColors(), height: TITLEBAR_H } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: true, // 右侧面板的浏览器
      plugins: true, // Chromium 自带的 PDF 阅读器（文件面板里预览 PDF）
    },
  });
  if (b.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('focus', () => win.flashFrame(false));

  // 界面里的外部链接用系统浏览器打开，窗口本身只显示本地界面
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(srv.url)) {
      e.preventDefault();
      openExternal(url);
    }
  });
  // 右侧面板的 <webview>：不给预加载脚本、不给 Node，只能打开网页和本地文件
  win.webContents.on('will-attach-webview', (e, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.webSecurity = true;
    params.partition = BROWSER_PARTITION;
    if (params.src && !/^(https?:|file:|about:blank)/i.test(params.src)) e.preventDefault();
  });

  // 没有菜单栏，常用快捷键在这里处理
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = input.key.toLowerCase();
    const wc = win.webContents;
    if (key === 'f12' || (ctrl && input.shift && key === 'i')) wc.toggleDevTools();
    else if (ctrl && input.shift && key === 'r') wc.reload(); // 不用 Ctrl+R / F5：终端里 Ctrl+R 是搜索历史命令
    else if (ctrl && (key === '=' || key === '+')) wc.setZoomLevel(wc.getZoomLevel() + 0.5);
    else if (ctrl && key === '-') wc.setZoomLevel(wc.getZoomLevel() - 0.5);
    else if (ctrl && key === '0') wc.setZoomLevel(0);
    else return;
    e.preventDefault();
  });

  win.on('close', (e) => {
    if (!quitting && srv && srv.busy() && !confirmStop(tr('停止并退出'), tr('退出会停止它们手上的工作。确定要退出吗？'))) {
      e.preventDefault();
      return;
    }
    saveBounds();
  });
  win.on('closed', () => (win = null));

  // 自动化检查用：设置 AGENT_CHAT_CAPTURE=图片路径 时，界面加载后把窗口内容存成图片
  if (process.env.AGENT_CHAT_CAPTURE) {
    win.webContents.setBackgroundThrottling(false); // 窗口被挡住时也照常绘制，截图才是最新的
    // AGENT_CHAT_THEME=light|dark：截图时指定深浅色
    if (process.env.AGENT_CHAT_THEME) nativeTheme.themeSource = process.env.AGENT_CHAT_THEME;
    // AGENT_CHAT_CAPTURE_TOP：截图时把窗口放到最前面（PDF 阅读器之类在窗口被挡住时不绘制）
    if (process.env.AGENT_CHAT_CAPTURE_TOP) win.once('show', () => win.setAlwaysOnTop(true));
    win.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        // AGENT_CHAT_CAPTURE_JS：截图前先在界面里执行一段脚本（比如点开某个预览），结果打印出来
        if (process.env.AGENT_CHAT_CAPTURE_JS) {
          const out = await win.webContents.executeJavaScript(process.env.AGENT_CHAT_CAPTURE_JS).catch((e) => ({ error: String(e) }));
          console.log('[capture-js]', JSON.stringify(out));
          await new Promise((r) => setTimeout(r, 1500));
        }
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.AGENT_CHAT_CAPTURE, img.toPNG());
        // AGENT_CHAT_CAPTURE_WINDOW：再存一张整个窗口的图（包括系统画的最小化 / 最大化 / 关闭按钮）
        if (process.env.AGENT_CHAT_CAPTURE_WINDOW) {
          const { desktopCapturer } = require('electron');
          const b = win.getBounds();
          const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: b.width, height: b.height } });
          const src = sources.find((s) => s.id === win.getMediaSourceId());
          if (src) fs.writeFileSync(process.env.AGENT_CHAT_CAPTURE_WINDOW, src.thumbnail.toPNG());
        }
        const info = await win.webContents.executeJavaScript('JSON.stringify({ desktop: typeof window.desktop, title: document.title })');
        console.log('[capture]', info, srv.url);
        if (process.env.AGENT_CHAT_CAPTURE_EXIT) {
          quitting = true;
          app.quit();
        }
      }, Number(process.env.AGENT_CHAT_CAPTURE_DELAY || 2500))
    );
  }

  await win.loadURL(srv.url);
}

// ---------- 右侧面板的浏览器 ----------
// 网页里新开窗口（target=_blank、window.open）：就在这个标签里打开；右键菜单给常用操作
app.on('web-contents-created', (e, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|file):/i.test(url)) contents.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  contents.on('will-navigate', (ev, url) => {
    if (!/^(https?|file|about|data|blob):/i.test(url)) ev.preventDefault(); // 不让网页唤起别的程序
  });
  contents.on('context-menu', (ev, p) => {
    const nav = contents.navigationHistory;
    const items = [
      { label: tr('后退'), enabled: nav.canGoBack(), click: () => nav.goBack() },
      { label: tr('前进'), enabled: nav.canGoForward(), click: () => nav.goForward() },
      { label: tr('重新加载'), click: () => contents.reload() },
      { type: 'separator' },
    ];
    if (p.linkURL) {
      items.push(
        { label: tr('在系统浏览器中打开链接'), click: () => openExternal(p.linkURL) },
        { label: tr('复制链接地址'), click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' }
      );
    }
    if (p.isEditable) items.push({ label: tr('剪切'), role: 'cut' }, { label: tr('复制'), role: 'copy' }, { label: tr('粘贴'), role: 'paste' }, { type: 'separator' });
    else if (p.selectionText) items.push({ label: tr('复制'), role: 'copy' }, { type: 'separator' });
    items.push({ label: tr('检查元素'), click: () => contents.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup({ window: win || undefined });
  });
});

// ---------- 给界面用的几个原生功能（见 preload.js） ----------
ipcMain.handle('titlebar', (e, c = {}) => {
  if (!win || IS_MAC) return;
  const hex = (v) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v) : null);
  const color = hex(c.color);
  const symbolColor = hex(c.symbolColor);
  if (color && symbolColor) win.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_H });
});

ipcMain.handle('paste', () => clipboard.readText());

ipcMain.handle('set-theme', (e, theme) => {
  if (['system', 'light', 'dark'].includes(theme)) nativeTheme.themeSource = theme;
});

ipcMain.handle('app-action', (e, name) => {
  if (!win) return;
  const wc = win.webContents;
  switch (name) {
    case 'devtools':
      return wc.toggleDevTools();
    case 'reload':
      return wc.reload();
    case 'zoom-in':
      return wc.setZoomLevel(wc.getZoomLevel() + 0.5);
    case 'zoom-out':
      return wc.setZoomLevel(wc.getZoomLevel() - 0.5);
    case 'zoom-reset':
      return wc.setZoomLevel(0);
  }
});
ipcMain.handle('pick-folder', async (e, start) => {
  const r = await dialog.showOpenDialog(win, {
    title: tr('选择项目文件夹'),
    defaultPath: start && fs.existsSync(start) ? start : undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

ipcMain.handle('copy', (e, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});

ipcMain.handle('notify', (e, { title, body } = {}) => {
  if (!win || win.isFocused()) return;
  win.flashFrame(true);
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: String(title || appName()).slice(0, 80), body: String(body || '').slice(0, 200), icon: iconPath() });
  n.on('click', showWindow);
  n.show();
});

// 自动更新：界面显示状态、手动检查、点「重启以完成更新」。状态变了由 main 推给界面（update-state）
ipcMain.handle('update-state', () => (updates ? updates.state() : null));
ipcMain.handle('update-check', () => (updates ? updates.check(true) : null));
ipcMain.handle('update-install', async () => {
  if (!updates || updates.state().status !== 'ready') return false;
  if (srv && srv.busy() && !confirmStop(tr('停止并更新'), tr('更新要重启 {app}，会停止它们手上的工作。确定现在更新吗？', { app: appName() }))) return false;
  quitting = true;
  // 安装前先停好成员、终端和服务：quitAndInstall 直接 app.quit()，不经过下面的 window-all-closed
  const ok = await updates.install(() => srv && srv.close());
  if (!ok) {
    // 没能启动安装（几乎不会发生）：服务已经停了，重新打开程序
    app.relaunch();
    app.exit(0);
  }
  return ok;
});

// ---------- 启动和退出 ----------
if (!app.requestSingleInstanceLock()) {
  // 已经开着一个了：让那个窗口到前面来，这个直接退出
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const browserSession = session.fromPartition(BROWSER_PARTITION);
    const ALLOWED = new Set(['fullscreen', 'clipboard-sanitized-write']);
    browserSession.setPermissionRequestHandler((wc, permission, cb) => cb(ALLOWED.has(permission)));
    browserSession.setPermissionCheckHandler((wc, permission) => ALLOWED.has(permission));
    try {
      const { start } = require('../server');
      const dataDir = process.env.AGENT_CHAT_DATA || path.join(app.getPath('userData'), 'data');
      // 外观（跟随系统 / 浅色 / 深色）要在窗口出来之前定好，免得先闪一下另一种颜色；语言也先定好，启动失败的提示才是对的语言
      const saved = require('../server/settings').readSettings(dataDir);
      nativeTheme.themeSource = saved.theme;
      setLang(saved.language);
      srv = await start({ dataDir, port: Number(process.env.AGENT_CHAT_PORT) || PORT, desktop: true });
    } catch (e) {
      dialog.showErrorBox(tr('{app} 启动失败', { app: appName() }), String((e && e.stack) || e));
      app.exit(1);
      return;
    }
    // 自动更新：只有安装版会在后台检查（见 updater.js）。日志在数据文件夹外面，%APPDATA%\Agent Chat\logs
    updates = updater.start({ app, logFile: path.join(app.getPath('userData'), 'logs', 'updater.log') });
    updates.onChange((s) => {
      if (win && !win.isDestroyed()) win.webContents.send('update-state', s);
    });
    await createWindow();
  });

  app.on('before-quit', () => (quitting = true));

  app.on('window-all-closed', async () => {
    if (srv) await srv.close();
    app.quit();
  });
}
