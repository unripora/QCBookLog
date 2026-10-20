/**
 * 局域网访问鉴权
 *
 * - 访问口令 8 位随机，仅存于内存，不落盘
 * - session token 落盘（QC_DATA_DIR/.auth/session.json，权限 0600），重启后免重复输入
 *   注意：token 长期有效等价于口令替代品，仅避免明文口令出现在磁盘
 * - ?t=<token> → 写入 HttpOnly cookie → 302 去掉 query
 * - 仅作用于局域网监听（监听 B），桌面窗口（监听 A）不受影响
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { AUTH_DIR } from './paths.js';

const SESSION_FILE = path.join(AUTH_DIR, 'session.json');
const COOKIE_NAME = 'qc_lan_token';
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/** 手机端必需的接口白名单（前缀匹配） */
const ALLOWED_PREFIXES = [
  '/api/books',
  '/api/bookmarks',
  '/api/readingstatus',
  '/api/health',
  '/api/version',
  '/api/tanshu/isbn/',
  '/api/douban/v2/book/isbn/',
  '/api/isbn-work/isbn/'
];

/** 无需鉴权即可访问的接口 */
const PUBLIC_PATHS = ['/api/health'];

const readSession = () => {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return raw?.token || null;
  } catch {
    return null;
  }
};

const writeSession = (token) => {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ token, createdAt: Date.now() }), {
    mode: 0o600
  });
  try {
    fs.chmodSync(SESSION_FILE, 0o600);
  } catch {
    // Windows 上 chmod 语义有限，忽略
  }
};

const parseCookies = (header = '') => {
  const result = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  });
  return result;
};

/**
 * 生成 8 位访问口令（剔除易混淆字符）
 */
const generatePasscode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes)
    .map((b) => alphabet[b % alphabet.length])
    .join('');
};

/**
 * 创建局域网鉴权中间件与口令管理
 *
 * 口令来源：QC_LAN_PASSCODE 环境变量（Electron 菜单开启时生成并持久化）
 *          未提供时每次启动随机生成
 */
export const createLanAuth = () => {
  const fromEnv = process.env.QC_LAN_PASSCODE;
  let passcode = fromEnv && fromEnv.trim() ? fromEnv.trim().toUpperCase() : generatePasscode();
  let token = readSession();

  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    writeSession(token);
  }

  const isAllowedPath = (reqPath) => {
    if (PUBLIC_PATHS.includes(reqPath)) return true;
    return ALLOWED_PREFIXES.some(
      (prefix) => reqPath === prefix || reqPath.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
    );
  };

  const renderLoginPage = (errorMessage = '') => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QC BookLog · 访问验证</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:#f5f6f8; }
  .card { width:min(92vw,360px); background:#fff; border-radius:14px; padding:28px 24px;
          box-shadow:0 6px 24px rgba(0,0,0,.08); }
  h1 { margin:0 0 6px; font-size:19px; }
  p { margin:0 0 18px; font-size:13px; color:#666; line-height:1.5; }
  input { width:100%; box-sizing:border-box; padding:11px 12px; font-size:16px; letter-spacing:2px;
          border:1px solid #d8dbe0; border-radius:8px; text-transform:uppercase; }
  button { width:100%; margin-top:14px; padding:11px; font-size:15px; color:#fff; background:#3b6ef6;
           border:0; border-radius:8px; }
  .err { color:#d33; font-size:13px; margin-top:10px; }
</style>
</head>
<body>
  <form class="card" method="GET">
    <h1>需要访问口令</h1>
    <p>请输入电脑端「手机访问」面板中显示的 8 位口令</p>
    <input name="t" autocomplete="off" autocapitalize="characters" maxlength="8" autofocus>
    <button type="submit">进入</button>
    ${errorMessage ? `<div class="err">${errorMessage}</div>` : ''}
  </form>
</body>
</html>`;

  const middleware = (req, res, next) => {
    const reqPath = req.path;

    // 只保护 API；静态页面与 SPA 路由放行（数据仍需鉴权）
    if (!reqPath.startsWith('/api/')) {
      return next();
    }

    if (!isAllowedPath(reqPath)) {
      return res.status(404).json({ error: 'Not Found' });
    }

    if (PUBLIC_PATHS.includes(reqPath)) {
      return next();
    }

    const queryToken = req.query.t;
    if (typeof queryToken === 'string' && queryToken === passcode) {
      res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: COOKIE_MAX_AGE_MS
      });
      // 登录成功后回到根路径，避免把口令残留在浏览器历史
      return res.redirect('/');
    }

    const cookies = parseCookies(req.headers.cookie);
    if (cookies[COOKIE_NAME] === token) {
      return next();
    }

    if (typeof queryToken === 'string' && queryToken.length > 0) {
      return res.status(401).send(renderLoginPage('口令不正确，请重新输入'));
    }
    return res.status(401).send(renderLoginPage());
  };

  return {
    middleware,
    getPasscode: () => passcode,
    getToken: () => token,
    /** 口令重置后需同步更新已下发 cookie 的对应 token */
    resetPasscode: () => {
      passcode = generatePasscode();
      token = crypto.randomBytes(24).toString('hex');
      writeSession(token);
      return passcode;
    }
  };
};

export default createLanAuth;
