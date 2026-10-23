'use strict';
// 自动更新：electron-updater，更新源是 GitHub Releases（Lauk1z/nightshift，写在 package.json 的 build.publish 里，
// 打包时 electron-builder 把它写进 resources/app-update.yml）。
// 只有 NSIS 安装版会检查：启动一会儿后在后台检查、下载，下载好了界面上提示「重启以完成更新」，用户点了才关掉程序、
// 静默运行新的安装包、装完再打开；不点就不装（平时退出也不装），下次启动还会提示，已经下载好的不用重新下。
// 出错（没网、GitHub 限流、校验或签名不对……）只写日志，不弹窗：%APPDATA%\Agent Chat\logs\updater.log。
// 下载的安装包一定要和 latest.yml 里的 sha512 对得上。程序没有代码签名（app-update.yml 里没有 publisherName），
// electron-updater 就不校验签名；以后签了名并配上 publisherName，签名对不上的安装包也会被丢掉。
// 下载的安装包放在 %LOCALAPPDATA%\agent-chat-updater；安装包只替换程序文件夹里的文件，
// 项目和聊天记录在 %APPDATA%\Agent Chat\data，更新不会动（electron-builder 的卸载程序只在 deleteAppDataOnUninstall
// 或 --delete-app-data 时删用户数据，这里都没有）。
// 界面上的文字在 public/account.js。
const fs = require('fs');
const path = require('path');

const FIRST_CHECK = 15 * 1000; // 启动后等一会儿再查，不和检测 AI 工具抢
const RECHECK = 6 * 3600 * 1000; // 一直开着的话，每 6 小时再查一次（出错了也是这时候重试）

// 什么情况下不检查更新。返回空字符串表示要检查，否则是原因（界面按它写说明）：
//   dev       没打包：npm start（electron .），app.isPackaged 是 false
//   platform  不是 Windows：只发了 Windows 的安装包
//   portable  免安装版：electron-builder 的免安装 exe 先把程序解压到临时文件夹再运行，并设置环境变量
//             PORTABLE_EXECUTABLE_DIR（原来那个 exe 所在的文件夹，见 app-builder-lib 的 templates/nsis/portable.nsi）。
//             安装包更新不了它，新版本要自己下载
//   unpacked  打包好了但不是装出来的，比如直接运行 dist/win-unpacked 里的 exe：NSIS 安装版的程序文件夹里一定有
//             卸载程序「Uninstall <exe 的名字>.exe」（templates/nsis/common.nsh 的 UNINSTALL_FILENAME），没有就不是安装版
// 网页版（start.bat → node server/index.js）不经过 Electron 的主进程，不会走到这里
function skipReason({ isPackaged, platform, env = {}, execPath = '', exists = fs.existsSync }) {
  if (!isPackaged) return 'dev';
  if (platform !== 'win32') return 'platform';
  if (env.PORTABLE_EXECUTABLE_DIR) return 'portable';
  const name = path.win32.basename(execPath).replace(/\.exe$/i, '');
  if (!name || !exists(path.win32.join(path.win32.dirname(execPath), `Uninstall ${name}.exe`))) return 'unpacked';
  return '';
}

// 出错的大致原因，界面按它写一句话（详细的在日志里）。
// 只看 code 和 message，不看调用栈（栈里的行号会被当成 403 / 429）；electron-updater 包了一层的错误，
// 里面那个错误的全文在 message 里（比如「Unable to find latest version on GitHub …: HttpError: 429 …」）
function errorKind(err) {
  const code = String((err && err.code) || '');
  const msg = String((err && err.message) || err || '');
  if (code === 'ERR_UPDATER_INVALID_SIGNATURE') return 'signature';
  if (code === 'ERR_CHECKSUM_MISMATCH' || /checksum mismatch/i.test(msg)) return 'checksum';
  if (/net::ERR_|\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b|socket hang up/i.test(`${code} ${msg}`)) return 'network';
  if ([403, 429].includes(err && err.statusCode) || /HttpError: (403|429)\b|\b(403 Forbidden|429 Too Many Requests)\b|rate limit/i.test(msg)) return 'limited';
  // 没有发过版、最新的 Release 里没传 latest.yml、latest.yml 写的安装包没传
  if (['ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'HTTP_ERROR_404'].includes(code)) return 'missing';
  return 'other';
}

// 更新的状态（主进程推给界面）：
//   status  off 不检查（reason 是原因）/ idle 还没查 / checking 正在查 / latest 已是最新 /
//           downloading 正在下载（next、percent）/ ready 下载好了，等用户点「重启以完成更新」/
//           installing 正在关掉程序去安装 / error 出错（error 是 errorKind 的结果）
// updater 是 electron-updater 的 autoUpdater（测试时换成假的）
class Updates {
  constructor({ updater = null, reason = '', version = '', log = null, logFile = '' } = {}) {
    this.updater = updater;
    this.log = log || { info() {}, warn() {}, error() {} };
    this.listeners = new Set();
    this.s = { status: reason ? 'off' : 'idle', reason, version, next: '', percent: 0, error: '', log: logFile };
    if (!updater) return;
    updater.on('checking-for-update', () => this.set({ status: 'checking', error: '' }));
    updater.on('update-not-available', () => this.set({ status: 'latest' }));
    updater.on('update-available', (info) => this.set({ status: 'downloading', next: info.version, percent: 0 }));
    updater.on('download-progress', (p) => {
      const percent = Math.min(99, Math.floor(p.percent || 0));
      if (this.s.status !== 'downloading' || percent !== this.s.percent) this.set({ status: 'downloading', percent });
    });
    updater.on('update-downloaded', (info) => this.set({ status: 'ready', next: info.version, percent: 100 }));
    // electron-updater 自己会把错误写进日志（logger.error）。已经下载好的不受影响（比如之后又查了一次但没网）
    updater.on('error', (err) => {
      if (this.s.status !== 'ready' && this.s.status !== 'installing') this.set({ status: 'error', error: errorKind(err) });
    });
  }

  state() {
    return { ...this.s };
  }

  set(patch) {
    this.s = { ...this.s, ...patch };
    for (const fn of this.listeners) fn(this.state());
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // 检查更新，有新版本就在后台下载。正在查、正在下或者已经下载好了就不重复
  check(manual = false) {
    if (!this.updater || ['checking', 'downloading', 'ready', 'installing'].includes(this.s.status)) return this.state();
    if (manual) this.log.info('Check for updates (manual)');
    this.set({ status: 'checking', error: '' }); // 界面马上显示「正在检查」
    Promise.resolve()
      .then(() => this.updater.checkForUpdates())
      .then((r) => {
        if (!r && this.s.status === 'checking') this.set({ status: 'idle' }); // electron-updater 没有真的去查
        // 下载出错和检查出错一样，已经由 error 事件写了日志、改了状态；这里接住，免得变成没处理的 Promise 错误
        return r && r.downloadPromise;
      })
      .catch(() => {});
    return this.state();
  }

  // 重启并安装：先让 main.js 停好成员、终端和服务（beforeInstall），再关掉程序、静默运行下载好的安装包
  // （--updated /S），装完自动打开新版本（--force-run）。返回 false 表示没能启动安装
  async install(beforeInstall) {
    if (!this.updater || this.s.status !== 'ready') return false;
    this.log.info(`Restart to install ${this.s.next}`);
    this.set({ status: 'installing' });
    try {
      if (beforeInstall) await beforeInstall();
    } catch (e) {
      this.log.warn(`Before install: ${(e && e.stack) || e}`);
    }
    // 安装包没找到之类的错误是 quitAndInstall 当场通过 error 事件报的
    let failed = false;
    const onError = () => (failed = true);
    this.updater.on('error', onError);
    try {
      this.updater.quitAndInstall(true, true);
    } catch (e) {
      failed = true;
      this.log.error(`quitAndInstall: ${(e && e.stack) || e}`);
    } finally {
      this.updater.removeListener('error', onError);
    }
    if (failed) this.set({ status: 'ready' });
    return !failed;
  }
}

// 写日志：每条前面是本地时间（错误后面跟着调用栈）；超过 1 MB 就把旧的改名成 updater.old.log
function fileLogger(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file.replace(/\.log$/, '.old.log'));
  } catch {}
  const pad = (n) => String(n).padStart(2, '0');
  const write = (level, args) => {
    const d = new Date();
    const time = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    let text = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    if (text.length > 4000) text = text.slice(0, 4000) + ' …'; // 有的错误带着整页 HTML
    try {
      fs.appendFileSync(file, `${time} ${level.padEnd(5)} ${text}\n`);
    } catch {}
  };
  return { info: (...a) => write('info', a), warn: (...a) => write('warn', a), error: (...a) => write('error', a), debug: (...a) => write('debug', a) };
}

// 由 main.js 在窗口出来之前调用。不检查更新的情况下不加载 electron-updater，也不写日志
function start({ app, logFile }) {
  const version = app.getVersion();
  const reason = skipReason({ isPackaged: app.isPackaged, platform: process.platform, env: process.env, execPath: process.execPath });
  if (reason) return new Updates({ reason, version });
  const log = fileLogger(logFile);
  const { autoUpdater } = require('electron-updater');
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true; // 查到新版本就在后台下载
  autoUpdater.autoInstallOnAppQuit = false; // 只在用户点了「重启以完成更新」时装，平时退出不装
  autoUpdater.disableWebInstaller = true; // 只用完整的安装包
  // 只在测试时用：换成本地的更新源（generic 提供方：放着 latest.yml 和安装包的地址）
  if (process.env.AGENT_CHAT_UPDATE_URL) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.AGENT_CHAT_UPDATE_URL });
  log.info(`Nightshift ${version} (${process.execPath})${process.env.AGENT_CHAT_UPDATE_URL ? ', feed ' + process.env.AGENT_CHAT_UPDATE_URL : ''}`);
  const updates = new Updates({ updater: autoUpdater, version, log, logFile });
  setTimeout(() => updates.check(), FIRST_CHECK);
  setInterval(() => updates.check(), RECHECK);
  return updates;
}

module.exports = { start, skipReason, errorKind, Updates, fileLogger };
