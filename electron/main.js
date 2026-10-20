/**
 * Electron 主进程入口
 *
 * 职责：
 *   1. 解析数据目录（userData/data），传给后端子进程
 *   2. 启动后端并拿到实际端口
 *   3. 打开 BrowserWindow 加载 http://127.0.0.1:<port>
 */

import { app, BrowserWindow, shell, dialog, session, Menu, clipboard } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import ServerManager from './server-manager.js';
import AppSettings from './settings.js';
import { pickPrimaryAddress } from './network.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;

/**
 * 后端入口解析：
 *   开发态：项目根 server/loader.js
 *   打包后：resources/server/loader.js（由 extraResources 解包到 asar 之外）
 */
const resolveServerEntry = () => {
  if (isDev) {
    return path.resolve(__dirname, '..', 'server', 'loader.js');
  }
  return path.join(process.resourcesPath, 'server', 'loader.js');
};

/** 前端静态资源目录：由 extraResources 放到 resources/dist（后端需直接读文件，不能在 asar 内） */
const resolveDistDir = () => {
  if (isDev) {
    return path.resolve(__dirname, '..', 'dist');
  }
  return path.join(process.resourcesPath, 'dist');
};

let mainWindow = null;
let serverManager = null;
let appSettings = null;

/**
 * 单实例锁：避免重复启动导致两份 SQLite 连接
 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

/**
 * 数据目录：用户目录下，卸载重装不丢失
 */
const resolveDataDir = () => {
  if (isDev && process.env.QC_DATA_DIR) {
    return process.env.QC_DATA_DIR;
  }
  return path.join(app.getPath('userData'), 'data');
};

const createWindow = (port) => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

/**
 * 放行摄像头权限（仅对本地后端窗口）
 */
const setupPermissions = () => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const origin = webContents.getURL();
    if (permission === 'media' && /^http:\/\/127\.0\.0\.1:\d+/.test(origin)) {
      callback(true);
      return;
    }
    callback(false);
  });
};

/**
 * 组装手机访问地址列表（含口令参数）
 */
const buildLanUrls = () => {
  if (!serverManager?.lanPort) return [];
  const passcode = appSettings?.lanPasscode || serverManager.lanPasscode || '';
  const addresses = [];
  const primary = pickPrimaryAddress();
  if (primary) addresses.push(primary.address);

  return addresses.map((ip) => ({
    label: `http://${ip}:${serverManager.lanPort}`,
    url: `http://${ip}:${serverManager.lanPort}/?t=${passcode}`
  }));
};

/**
 * 展示手机访问信息
 */
const showLanInfo = () => {
  if (!appSettings?.lanEnabled) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '手机访问',
      message: '手机访问当前已关闭',
      detail: '可通过「设置 → 允许手机访问」开启。',
      buttons: ['知道了']
    });
    return;
  }

  const urls = buildLanUrls();
  if (urls.length === 0) {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '手机访问',
      message: '未检测到局域网地址',
      detail: '请确认电脑已连接 Wi-Fi 或有线网络。',
      buttons: ['知道了']
    });
    return;
  }

  const passcode = appSettings.lanPasscode || '';
  const detail = [
    `访问地址：${urls[0].label}`,
    `访问口令：${passcode}`,
    '',
    '手机需与本机连接同一局域网。',
    '若打不开，请检查 Windows 防火墙是否允许本程序入站。',
    '非 HTTPS 环境下扫码会调用系统相机拍照，识别效果一致。'
  ].join('\n');

  dialog
    .showMessageBox(mainWindow, {
      type: 'info',
      title: '手机访问',
      message: `手机访问已开启（端口 ${serverManager.lanPort}）`,
      detail,
      buttons: ['复制地址', '关闭'],
      defaultId: 0,
      cancelId: 1
    })
    .then(({ response }) => {
      if (response === 0) clipboard.writeText(urls[0].url);
    });
};

/**
 * 切换手机访问开关（切换后需重启后端以生效）
 */
const toggleLanAccess = async () => {
  const next = !appSettings.lanEnabled;
  appSettings.setLanEnabled(next);

  if (next && !serverManager.lanPasscode) {
    serverManager.lanPasscode = appSettings.lanPasscode;
  }

  try {
    const port = await serverManager.restart({
      lanEnabled: next,
      lanPasscode: next ? appSettings.lanPasscode : null
    });
    if (mainWindow) mainWindow.loadURL(`http://127.0.0.1:${port}`);
    showLanInfo();
  } catch (err) {
    dialog.showErrorBox('切换失败', `重启后端服务失败：\n${err.message}`);
  }
};

/**
 * 构造应用菜单
 */
const buildMenu = () => {
  const template = [
    {
      label: '设置',
      submenu: [
        {
          label: '允许手机访问',
          type: 'checkbox',
          checked: !!appSettings?.lanEnabled,
          click: () => toggleLanAccess()
        },
        {
          label: '显示手机访问信息',
          click: () => showLanInfo()
        },
        { type: 'separator' },
        {
          label: '重置访问口令',
          click: () => {
            const code = appSettings.resetPasscode();
            serverManager.lanPasscode = code;
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '访问口令已重置',
              message: `新口令：${code}`,
              detail: '需重启应用后生效。',
              buttons: ['知道了']
            });
          }
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

const bootstrap = async () => {
  const dataDir = resolveDataDir();
  const serverEntry = resolveServerEntry();
  const distDir = resolveDistDir();

  appSettings = new AppSettings(app.getPath('userData'));

  const lanEnabled = appSettings.lanEnabled;
  const lanPasscode = lanEnabled ? appSettings.ensurePasscode() : null;

  serverManager = new ServerManager({ serverEntry, dataDir, distDir, lanEnabled, lanPasscode });

  try {
    const port = await serverManager.start();
    setupPermissions();
    buildMenu();
    createWindow(port);
  } catch (err) {
    dialog.showErrorBox('启动失败', `后端服务启动失败：\n${err.message}`);
    app.quit();
  }
};

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverManager?.port) {
    createWindow(serverManager.port);
  }
});

app.on('before-quit', () => {
  serverManager?.stop();
});
