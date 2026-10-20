/**
 * 后端服务管理器
 *
 * 负责在 Electron 主进程中 fork 后端 Node 进程，并把实际监听端口回传给主进程。
 */

import { fork } from 'child_process';
import path from 'path';
import http from 'http';

const HEALTH_TIMEOUT_MS = 30000;
const HEALTH_INTERVAL_MS = 300;

/**
 * 解析后端子进程输出的端口信息
 * 后端启动时会打印：SERVER_LISTENING_PORT=<port>
 */
const parsePortFromLine = (line) => {
  const match = line.match(/SERVER_LISTENING_PORT=(\d+)/);
  return match ? Number(match[1]) : null;
};

/** 解析局域网监听端口 */
const parseLanPortFromLine = (line) => {
  const match = line.match(/LAN_LISTENING_PORT=(\d+)/);
  return match ? Number(match[1]) : null;
};

/** 解析局域网访问口令 */
const parseLanPasscodeFromLine = (line) => {
  const match = line.match(/LAN_PASSCODE=([A-Z0-9]+)/);
  return match ? match[1] : null;
};

const waitForHealth = (port, timeoutMs = HEALTH_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const tryOnce = () => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/api/health', timeout: 1000 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) {
            resolve(port);
          } else {
            retry();
          }
        }
      );
      req.on('error', retry);
      req.on('timeout', () => {
        req.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error(`后端健康检查超时（${timeoutMs}ms）`));
        return;
      }
      setTimeout(tryOnce, HEALTH_INTERVAL_MS);
    };

    tryOnce();
  });

class ServerManager {
  constructor({ serverEntry, dataDir, distDir, lanEnabled = false, lanPasscode = null }) {
    this.serverEntry = serverEntry;
    this.dataDir = dataDir;
    this.distDir = distDir;
    this.lanEnabled = lanEnabled;
    this.lanPasscode = lanPasscode;
    this.child = null;
    this.port = null;
    this.lanPort = null;
    this._lanResolvers = [];
  }

  /**
   * 启动后端进程，返回实际监听端口
   */
  async start() {
    const child = fork(this.serverEntry, [], {
      cwd: path.dirname(this.serverEntry),
      env: {
        ...process.env,
        QC_DATA_DIR: this.dataDir,
        QC_DIST_DIR: this.distDir,
        QC_PORT: '0',
        LAN_ENABLED: this.lanEnabled ? '1' : '0',
        ...(this.lanEnabled && this.lanPasscode ? { QC_LAN_PASSCODE: this.lanPasscode } : {}),
        NODE_ENV: 'production'
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });

    this.child = child;

    child.stdout.on('data', (buf) => {
      for (const line of buf.toString().split('\n')) {
        const port = parsePortFromLine(line);
        if (port) this.port = port;

        const lanPort = parseLanPortFromLine(line);
        if (lanPort) this.lanPort = lanPort;

        const passcode = parseLanPasscodeFromLine(line);
        if (passcode) {
          this.lanPasscode = passcode;
          this._resolveLanReady();
        }

        if (line.trim()) console.log(`[backend] ${line.trim()}`);
      }
    });

    child.stderr.on('data', (buf) => {
      console.error(`[backend:err] ${buf.toString().trim()}`);
    });

    child.on('exit', (code, signal) => {
      console.log(`[backend] 进程退出 code=${code} signal=${signal}`);
      this.child = null;
      this.port = null;
      this.lanPort = null;
      this.lanPasscode = null;
    });

    child.on('error', (err) => {
      console.error('[backend] 进程错误:', err);
    });

    const port = await this._waitForPort(child);
    if (!port) {
      throw new Error('后端启动失败：未获取到监听端口');
    }

    await waitForHealth(port);
    this.port = port;

    // 局域网已开启时，等后端把端口和口令打出来
    if (this.lanEnabled) {
      await this.waitForLan(time => console.warn(`[backend] 局域网监听启动超时：${time}ms`));
    }

    return port;
  }

  /**
   * 等待局域网监听就绪（返回 {port, passcode}）
   */
  waitForLan(onTimeout) {
    if (this.lanPort && this.lanPasscode) {
      return Promise.resolve({ port: this.lanPort, passcode: this.lanPasscode });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._lanResolvers = this._lanResolvers.filter((r) => r !== onResolve);
        onTimeout?.(HEALTH_TIMEOUT_MS);
        resolve(null);
      }, HEALTH_TIMEOUT_MS);

      const onResolve = () => {
        clearTimeout(timer);
        resolve({ port: this.lanPort, passcode: this.lanPasscode });
      };
      this._lanResolvers.push(onResolve);
    });
  }

  _resolveLanReady() {
    const resolvers = this._lanResolvers;
    this._lanResolvers = [];
    resolvers.forEach((fn) => fn());
  }

  _waitForPort(child) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + HEALTH_TIMEOUT_MS;

      const timer = setInterval(() => {
        if (this.port) {
          clearInterval(timer);
          resolve(this.port);
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error('后端启动超时：未获取到监听端口'));
        }
      }, 100);

      child.once('exit', () => {
        clearInterval(timer);
        reject(new Error('后端进程启动后立即退出'));
      });
    });
  }

  /**
   * 停止后端进程
   */
  stop() {
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }

  /**
   * 切换局域网开关后重启后端（端口与局域网监听都会重新分配）
   */
  async restart({ lanEnabled, lanPasscode = null }) {
    this.stop();
    this.lanEnabled = lanEnabled;
    this.lanPasscode = lanPasscode;
    this.port = null;
    this.lanPort = null;
    await new Promise((resolve) => setTimeout(resolve, 800));
    return this.start();
  }
}

export default ServerManager;
export { ServerManager };
