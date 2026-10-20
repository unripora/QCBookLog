/**
 * Cloudflare Quick Tunnel 管理
 *
 * 免登录获取 https://*.trycloudflare.com 地址（有效证书 → 安全上下文成立）
 * 注意：地址每次启动都变、公网可达、无 SLA；必须配合访问口令使用
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;
const START_TIMEOUT_MS = 30000;

class TunnelManager {
  constructor({ binaryPath, targetUrl, onLog }) {
    this.binaryPath = binaryPath;
    this.targetUrl = targetUrl;
    this.onLog = onLog || (() => {});
    this.child = null;
    this.url = null;
  }

  /**
   * 启动隧道，resolve 时返回公网地址
   */
  start() {
    if (this.url) return Promise.resolve(this.url);

    if (!fs.existsSync(this.binaryPath)) {
      return Promise.reject(
        new Error(`未找到 cloudflared：${this.binaryPath}。请先下载 cloudflared.exe 或使用局域网访问。`)
      );
    }

    return new Promise((resolve, reject) => {
      const child = spawn(
        this.binaryPath,
        ['tunnel', '--url', this.targetUrl, '--no-autoupdate'],
        { windowsHide: true }
      );
      this.child = child;

      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          this.stop();
          reject(err);
        } else {
          resolve(value);
        }
      };

      const timer = setTimeout(() => {
        finish(
          new Error(
            '隧道启动超时（30s）。请检查网络连通性、代理设置，以及出站 443 端口是否被防火墙拦截。'
          )
        );
      }, START_TIMEOUT_MS);

      const handleOutput = (buf) => {
        const text = buf.toString();
        this.onLog(text.trim());

        if (!this.url) {
          const matches = text.match(URL_PATTERN);
          if (matches && matches.length > 0) {
            this.url = matches[0];
            finish(null, this.url);
          }
        }
      };

      child.stdout.on('data', handleOutput);
      child.stderr.on('data', handleOutput);

      child.on('error', (err) => {
        finish(new Error(`无法启动 cloudflared：${err.message}`));
      });

      child.on('exit', (code) => {
        this.child = null;
        if (!this.url) {
          finish(new Error(`cloudflared 异常退出（code=${code}）`));
        }
        this.url = null;
      });
    });
  }

  stop() {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this.url = null;
  }

  getUrl() {
    return this.url;
  }

  isRunning() {
    return !!this.child;
  }
}

export default TunnelManager;
export { TunnelManager };
