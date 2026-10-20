/**
 * 桌面端本地配置
 *
 * 存放于 userData/settings.json，与书库数据（userData/data）分离，
 * 避免被备份/恢复流程覆盖。
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 生成 8 位易输入口令（剔除 I/O/0/1） */
export const generatePasscode = () => {
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes)
    .map((b) => ALPHABET[b % ALPHABET.length])
    .join('');
};

class AppSettings {
  constructor(userDataDir) {
    this.filePath = path.join(userDataDir, 'settings.json');
    this.data = this._load();
  }

  _load() {
    const defaults = { lanEnabled: false, lanPasscode: null };
    try {
      if (!fs.existsSync(this.filePath)) return defaults;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return {
        lanEnabled: !!raw.lanEnabled,
        lanPasscode: typeof raw.lanPasscode === 'string' ? raw.lanPasscode : null
      };
    } catch (err) {
      console.warn('读取 settings.json 失败，使用默认配置:', err.message);
      return defaults;
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.warn('保存 settings.json 失败:', err.message);
    }
  }

  get lanEnabled() {
    return this.data.lanEnabled;
  }

  /** 开启局域网时确保有固定口令，便于反复使用与展示 */
  ensurePasscode() {
    if (!this.data.lanPasscode) {
      this.data.lanPasscode = generatePasscode();
      this.save();
    }
    return this.data.lanPasscode;
  }

  get lanPasscode() {
    return this.data.lanPasscode;
  }

  setLanEnabled(enabled) {
    this.data.lanEnabled = !!enabled;
    if (enabled) this.ensurePasscode();
    this.save();
    return this.data;
  }

  /** 重新生成口令（旧口令立即失效） */
  resetPasscode() {
    this.data.lanPasscode = generatePasscode();
    this.save();
    return this.data.lanPasscode;
  }
}

export default AppSettings;
export { AppSettings };
