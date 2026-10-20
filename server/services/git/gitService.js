/**
 * GitService - 封装 simple-git 操作，提供串行队列确保同一时间只有一个 git 进程
 *
 * 功能范围（当前阶段只做 commit + push，pull 后续实现）：
 *   - 仓库初始化：已存在则打开，否则 clone（配置了 repoUrl 且本地无仓库时）
 *   - 配置读写：repoUrl / branch / token / authorName / authorEmail
 *   - add / commit / push（串行队列 + index.lock 检测与短暂重试）
 *   - status：检查是否已配置、是否有未推送提交、最近一次提交信息
 *   - 敏感信息脱敏：日志不打印 token
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import simpleGit from 'simple-git';
import userSettingsService from '../settings/userSettingsService.js';
import { DATA_DIR } from '../../utils/paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 请求参数类错误（对应 HTTP 400） */
export class GitBadRequestError extends Error {}
/** 资源不存在类错误（对应 HTTP 404） */
export class GitNotFoundError extends Error {}
/** 历史改写冲突类错误（对应 HTTP 409）：需用户调整历史后重试，非服务端故障 */
export class GitConflictError extends Error {}

const SETTING_KEYS = {
  REPO_URL: 'gitRepoUrl',
  BRANCH: 'gitBranch',
  TOKEN: 'gitToken',
  USER_NAME: 'gitUserName',
  USER_EMAIL: 'gitUserEmail',
  AUTO_PUSH: 'gitAutoPush',
  LAST_SYNC_AT: 'gitLastSyncAt',
  LAST_ERROR: 'gitLastError',
  INITIALIZED: 'gitInitialized',
  MIRRORS: 'gitMirrors',
  PROXY: 'gitProxy',
};

// 同步仓库目录：与数据库同目录（DATA_DIR/sync-repo）
function getDefaultRepoDir() {
  return path.join(DATA_DIR, 'sync-repo');
}

const DEFAULT_REPO_DIR = getDefaultRepoDir();
const LOCK_WAIT_MS = 3000;
const LOCK_RETRY_INTERVAL = 500;
const NETWORK_TIMEOUT_MS = 8000;
const PUSH_TIMEOUT_MS = 60 * 1000;

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message || '操作超时')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function maskUrl(url) {
  if (!url) return '';
  // https://x-access-token:TOKEN@github.com/owner/repo.git -> https://***@github.com/owner/repo.git
  return url.replace(/(https?:\/\/)([^@/]+:[^@]+)@/i, '$1***@');
}

class GitService {
  constructor() {
    this._queue = Promise.resolve();
    this._repoDir = DEFAULT_REPO_DIR;
    this._git = null;
    this._ready = false;
    // 远端测速缓存：{ selected, results, at }
    this._speedCache = null;
  }

  /**
   * 启动时调用：确保目录存在、若已配置则打开/克隆仓库、设置默认 author
   */
  async init() {
    try {
      fs.mkdirSync(this._repoDir, { recursive: true });
      // 解决容器中挂载目录的 git "dubious ownership" 问题
      await this._ensureSafeDir(this._repoDir);

      const repoUrl = await this._getSetting(SETTING_KEYS.REPO_URL);
      const branch = (await this._getSetting(SETTING_KEYS.BRANCH)) || 'main';

      if (repoUrl) {
        await this._ensureRepo(repoUrl, branch);
      } else {
        // 未配置远端：若目录已有 .git 则直接用，否则初始化一个本地仓库（用户后续可配置）
        if (fs.existsSync(path.join(this._repoDir, '.git'))) {
          this._git = simpleGit(this._repoDir);
        } else {
          this._git = simpleGit(this._repoDir);
          await this._git.init();
          await this._applyAuthor();
          const readmePath = path.join(this._repoDir, 'README.md');
          if (!fs.existsSync(readmePath)) {
            fs.writeFileSync(readmePath, '# QCBookLog 书评同步仓库\n', 'utf8');
            await this._git.add('README.md');
            await this._git.commit('chore: 初始化书评同步仓库');
          }
        }
        await this._applyAuthor();
        this._ready = true;
        console.log('[GitService] 本地仓库已就绪:', this._repoDir);
      }
    } catch (err) {
      console.error('[GitService] 初始化失败:', err.message);
      // 初始化失败不阻塞服务启动，等用户配置后可重试
      this._ready = false;
    }
  }

  isReady() {
    return this._ready && !!this._git;
  }

  getRepoDir() {
    return this._repoDir;
  }

  /**
   * 读取配置状态（前端展示用）
   */
  async getStatus() {
    const repoUrl = await this._getSetting(SETTING_KEYS.REPO_URL);
    const branch = (await this._getSetting(SETTING_KEYS.BRANCH)) || 'main';
    const userName = await this._getSetting(SETTING_KEYS.USER_NAME);
    const userEmail = await this._getSetting(SETTING_KEYS.USER_EMAIL);
    const autoPush = await this._getSetting(SETTING_KEYS.AUTO_PUSH);
    const lastSyncAt = await this._getSetting(SETTING_KEYS.LAST_SYNC_AT);
    const lastError = await this._getSetting(SETTING_KEYS.LAST_ERROR);
    const tokenExists = !!(await this._getSetting(SETTING_KEYS.TOKEN));
    const localRepoExists = fs.existsSync(path.join(this._repoDir, '.git'));
    const mirrors = await this._getMirrors();
    const proxy = await this._getSetting(SETTING_KEYS.PROXY);

    return {
      configured: !!repoUrl && tokenExists,
      repoUrl: maskUrl(repoUrl || ''),
      mirrors,
      proxy: proxy || '',
      branch,
      userName: userName || '',
      userEmail: userEmail || '',
      autoPush: autoPush === true || autoPush === 'true',
      tokenConfigured: tokenExists,
      localRepoExists,
      repoDir: this._repoDir,
      lastSyncAt: lastSyncAt || null,
      lastError: lastError || null,
      ready: this.isReady(),
    };
  }

  /**
   * 保存配置（仓库地址、token、分支、作者），并立即尝试 init/clone
   */
  async configure({ repoUrl, branch, token, userName, userEmail, autoPush, mirrors, proxy }) {
    const tasks = [];
    if (repoUrl !== undefined) tasks.push(['save', SETTING_KEYS.REPO_URL, repoUrl]);
    if (branch !== undefined) tasks.push(['save', SETTING_KEYS.BRANCH, branch]);
    if (token !== undefined) tasks.push(['save', SETTING_KEYS.TOKEN, token]);
    if (userName !== undefined) tasks.push(['save', SETTING_KEYS.USER_NAME, userName]);
    if (userEmail !== undefined) tasks.push(['save', SETTING_KEYS.USER_EMAIL, userEmail]);
    if (autoPush !== undefined) tasks.push(['save', SETTING_KEYS.AUTO_PUSH, !!autoPush]);
    if (mirrors !== undefined) tasks.push(['save', SETTING_KEYS.MIRRORS, this._normalizeMirrors(mirrors).join('\n')]);
    if (proxy !== undefined) tasks.push(['save', SETTING_KEYS.PROXY, (typeof proxy === 'string' ? proxy.trim() : proxy) || '']);

    for (const [, key, val] of tasks) {
      await userSettingsService.saveSetting(0, key, val);
    }

    const finalUrl = repoUrl !== undefined ? repoUrl : (await this._getSetting(SETTING_KEYS.REPO_URL));
    const finalBranch = (branch !== undefined ? branch : await this._getSetting(SETTING_KEYS.BRANCH)) || 'main';

    if (finalUrl) {
      try {
        await this._ensureRepo(finalUrl, finalBranch);
        await userSettingsService.saveSetting(0, SETTING_KEYS.INITIALIZED, true);
        await userSettingsService.saveSetting(0, SETTING_KEYS.LAST_ERROR, '');
      } catch (err) {
        await userSettingsService.saveSetting(0, SETTING_KEYS.LAST_ERROR, err.message);
        throw err;
      }
    }

    // 代理配置变更时即时生效（即使仓库还没初始化也先存设置）
    if (this._git) {
      await this._applyProxy();
    }

    return this.getStatus();
  }

  /**
   * 串行执行 git 任务（队列保证不会有并发 git 进程）
   */
  _enqueue(taskName, fn) {
    const run = async () => {
      await this._waitForLock();
      try {
        return await fn(this._git);
      } catch (err) {
        // 把 index.lock 相关错误统一处理
        if (err && err.message && err.message.includes('index.lock')) {
          const lockPath = path.join(this._repoDir, '.git', 'index.lock');
          try { fs.unlinkSync(lockPath); } catch {}
          await new Promise(r => setTimeout(r, 200));
          return await fn(this._git); // 重试一次
        }
        throw err;
      }
    };

    this._queue = this._queue.then(run, run);
    return this._queue;
  }

  async _waitForLock() {
    const lockPath = path.join(this._repoDir, '.git', 'index.lock');
    const start = Date.now();
    while (fs.existsSync(lockPath) && Date.now() - start < LOCK_WAIT_MS) {
      await new Promise(r => setTimeout(r, LOCK_RETRY_INTERVAL));
    }
    if (fs.existsSync(lockPath)) {
      // 超时，删除可能是上次遗留的锁
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }

  /**
   * 核心提交并推送：对指定文件 add → commit → push（push 仅在 autoPush=true 或 forcePush=true 时执行）
   * forceLease=true 时使用 --force-with-lease 强推（用于重写历史后的同步删除）
   */
  async commitAndPush({ files = [], message, forcePush = false, forceLease = false, expectRemoteHash = '' }) {
    if (!this.isReady()) {
      throw new Error('Git 仓库尚未初始化，请先配置同步仓库');
    }

    return this._enqueue('commitAndPush', async (git) => {
      const result = { committed: false, pushed: false, commitHash: null };

      const branch = (await this._getSetting(SETTING_KEYS.BRANCH)) || 'main';

      // 确保本地当前分支与配置分支一致（git init 默认是 master，而配置常为 main）
      try {
        const cur = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
        if (cur !== branch) {
          // checkout -B 会把分支指到当前 HEAD，保留已有提交历史
          await git.raw(['checkout', '-B', branch]);
          console.log(`[GitService] 分支 ${cur} 不等于配置分支 ${branch}，已切换到 ${branch}`);
        }
      } catch (e) {
        // 尚无任何提交（unborn HEAD）：直接把 HEAD 指向配置分支
        await git.raw(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]).catch(() => {});
      }

      if (files && files.length > 0) {
        await git.add(files);
      } else {
        await git.add('.');
      }

      const status = await git.status();
      const hasChanges = !status.isClean();
      if (!hasChanges) {
        result.committed = false;
        result.note = '没有可提交的变更';
      } else {
        await this._applyAuthor();
        const commitRes = await git.commit(message);
        result.committed = true;
        result.commitHash = commitRes.commit;
      }

      const autoPush = await this._getSetting(SETTING_KEYS.AUTO_PUSH);
      const shouldPush = forcePush || autoPush === true || autoPush === 'true';
      const token = await this._getSetting(SETTING_KEYS.TOKEN);
      const repoUrl = await this._getSetting(SETTING_KEYS.REPO_URL);

      if (shouldPush && token && repoUrl) {
        // 只在本次 push 使用带 token 的 URL，不写入 remote 配置
        let pushOptions = { '--set-upstream': null };
        if (forceLease) {
          // 先确认远端不含本地不知道的提交，再强推（详见 _assertRemoteIsKnown 说明）
          await this._assertRemoteIsKnown(git, repoUrl, token, branch, expectRemoteHash);
          pushOptions = { '--force': null };
        }
        await this._pushWithFallback(git, branch, pushOptions);
        result.pushed = true;
        await userSettingsService.saveSetting(0, SETTING_KEYS.LAST_SYNC_AT, new Date().toISOString());
        await userSettingsService.saveSetting(0, SETTING_KEYS.LAST_ERROR, '');
        // 推送成功后做一次轻量 gc，压缩松散对象
        await this._maybeGc();
      } else if (shouldPush && (!token || !repoUrl)) {
        const msg = !repoUrl ? '未配置仓库地址' : '未配置 Token，无法 push';
        await userSettingsService.saveSetting(0, SETTING_KEYS.LAST_ERROR, msg);
        throw new Error(msg);
      }

      return result;
    });
  }

  /**
   * 从远端拉取并更新本地工作区（走串行队列）。
   * @param {Object} options
   * @param {'merge'|'overwrite'} options.mode - merge: 尝试合并（本地未推送提交 rebase 到远端之上）；overwrite: 用远端强制覆盖本地
   * @returns { pulled, fastForwarded, rebased, reset, conflicts }
   */
  async pull({ mode = 'merge' } = {}) {
    if (!this.isReady()) {
      throw new Error('Git 仓库尚未初始化，请先配置同步仓库');
    }
    const repoUrl = await this._getSetting(SETTING_KEYS.REPO_URL);
    const token = await this._getSetting(SETTING_KEYS.TOKEN);
    if (!repoUrl || !token) {
      throw new Error('未配置仓库地址或 Token，无法拉取');
    }
    const branch = (await this._getSetting(SETTING_KEYS.BRANCH)) || 'main';

    return this._enqueue('pull', async (git) => {
      // 测速选路：用最快的可用远端 fetch
      const fast = await this.selectFastestRemote();
      const authedUrl = fast?.selected || this._buildAuthedUrl(repoUrl, token);

      // 1. 工作区不干净时先 stash，拉取完成后尽量恢复
      const status = await git.status();
      let stashed = false;
      if (!status.isClean()) {
        await git.stash(['push', '-u', '-m', 'qcbooklog-pull-autostash']);
        stashed = true;
      }

      try {
        // 2. fetch 远端分支到 FETCH_HEAD
        await git.fetch(authedUrl, branch);
        let fetchHash = '';
        try {
          fetchHash = (await git.raw(['rev-parse', 'FETCH_HEAD'])).trim();
        } catch {
          fetchHash = '';
        }
        if (!fetchHash) {
          throw new Error('无法获取远端分支状态，请检查仓库地址与分支是否正确');
        }

        // 3. 判断本地与远端的领先/落后关系
        let ahead = 0;
        let behind = 0;
        try {
          ahead = parseInt((await git.raw(['rev-list', '--count', `${fetchHash}..HEAD`])).trim(), 10) || 0;
          behind = parseInt((await git.raw(['rev-list', '--count', `HEAD..${fetchHash}`])).trim(), 10) || 0;
        } catch {
          ahead = 0;
          behind = 0;
        }

        // 4. 执行合并策略
        if (mode === 'overwrite') {
          // 用远端强制覆盖本地
          await git.reset(['--hard', 'FETCH_HEAD']);
          await this._popStash(git, stashed);
          await userSettingsService.saveSetting(0, SETTING_KEYS.LAST_SYNC_AT, new Date().toISOString());
          await userSettingsService.saveSetting(0, SETTING_KEYS.LAST_ERROR, '');
          await this._maybeGc();
          return { pulled: true, fastForwarded: true, rebased: false, reset: true, conflicts: [] };
        }

        if (ahead > 0 && behind > 0) {
          // 双方都有提交（分叉）：尝试把本地提交 rebase 到远端之上
          try {
            await git.rebase(['FETCH_HEAD']);
            await this._popStash(git, stashed);
            await userSettingsService.saveSetting(0, SETTING_KEYS.LAST_SYNC_AT, new Date().toISOString());
            await userSettingsService.saveSetting(0, SETTING_KEYS.LAST_ERROR, '');
            await this._maybeGc();
            return { pulled: true, fastForwarded: false, rebased: true, reset: false, conflicts: [] };
          } catch (err) {
            await git.rebase(['--abort']).catch(() => {});
            throw new Error('本地与远端存在分叉且合并失败，请先处理冲突，或改用「覆盖模式」拉取');
          }
        }

        // 5. 快进合并（behind > 0）
        if (behind > 0) {
          await git.merge(['FETCH_HEAD', '--ff-only']);
        }
        await this._popStash(git, stashed);
        await userSettingsService.saveSetting(0, SETTING_KEYS.LAST_SYNC_AT, new Date().toISOString());
        await userSettingsService.saveSetting(0, SETTING_KEYS.LAST_ERROR, '');
        await this._maybeGc();
        return { pulled: true, fastForwarded: behind > 0, rebased: false, reset: false, conflicts: [] };
      } catch (err) {
        // 出错时尽量恢复 stash，避免工作区状态丢失
        await this._popStash(git, stashed);
        throw err;
      }
    });
  }

  async _popStash(git, stashed) {
    if (!stashed) return;
    try {
      await git.stash(['pop']);
    } catch (e) {
      console.warn('[GitService] 拉取后恢复 stash 失败（可手动 git stash pop）:', e.message);
    }
  }

  /**
   * 回滚仓库到指定提交：先尝试中止可能残留的 rebase，再硬回退。
   * @param {Object} git simple-git 实例
   * @param {string} headHash 目标提交
   * @param {string} branch 分支名
   * @returns {boolean} 是否回滚成功
   */
  async _rollbackTo(git, headHash, branch) {
    try {
      // rebase/filter-branch 可能中途失败留下中断态，需先中止
      await git.raw(['rebase', '--abort']).catch(() => {});
      await git.raw(['cherry-pick', '--abort']).catch(() => {});
      await git.reset(['--hard', headHash]);
      // 清理 filter-branch 可能留下的备份引用
      await git.raw(['update-ref', '-d', `refs/original/refs/heads/${branch}`]).catch(() => {});
      return true;
    } catch (e) {
      console.error('[GitService] 回滚失败:', e.message);
      return false;
    }
  }

  /**
   * 删除单个历史 commit（重写历史），可同步强推删除远端记录。
   * @param {string} commitHash - 要删除的提交
   * @param {Object} options
   * @param {boolean} options.push - 是否强推远端
   * @returns { dropped, head, pushed }
   */
  async dropCommit(commitHash, { push = false } = {}) {
    if (!this.isReady()) {
      throw new Error('Git 仓库尚未初始化');
    }
    return this._enqueue('drop', async (git) => {
      const branch = (await this._getSetting(SETTING_KEYS.BRANCH)) || 'main';

      // 工作区必须干净，否则 rebase 会失败
      const status = await git.status();
      if (!status.isClean()) {
        throw new Error('工作区有未提交的变更，请先同步或保存后再删除历史');
      }

      const headHash = (await git.revparse(['HEAD'])).trim();
      let target = '';
      let parent = '';
      try {
        target = (await git.revparse([`${commitHash}^{commit}`])).trim();
        parent = (await git.revparse([`${target}^`])).trim();
      } catch (e) {
        throw new GitBadRequestError('无效的提交哈希：' + commitHash);
      }
      if (!parent) {
        throw new GitBadRequestError('该提交是仓库初始提交，无法单独删除');
      }

      // 重写历史 + 强推需保证原子性：任一步失败都回滚到原 HEAD，
      // 避免本地与远端静默分叉、或仓库卡在 rebase 中断态
      let pushed = false;
      try {
        if (target === headHash) {
          // 目标就是 HEAD：直接回退到父提交
          await git.reset(['--hard', parent]);
        } else {
          // 中间提交：rebase --onto 丢弃该提交
          await git.raw(['rebase', '--onto', parent, target, branch]);
        }

        if (push) {
          // 重写后本地 HEAD 是全新构造的，与远端无祖先关系，
          // 故要求远端严格等于重写前的本地 HEAD（即操作开始时的远端状态）
          pushed = await this._pushForceWithLease(git, branch, headHash);
        }
      } catch (err) {
        await this._rollbackTo(git, headHash, branch);
        // 语义化错误（如安全校验中止）已带明确含义与状态码，原样上抛
        if (err instanceof GitConflictError || err instanceof GitBadRequestError || err instanceof GitNotFoundError) {
          throw err;
        }
        // 删除中间提交需重放其后的提交，若这些提交改动了同一处内容，
        // 会产生真实的内容冲突（非服务端故障），提示用户改用其他方式处理
        const raw = err?.message || '';
        if (/CONFLICT|could not apply|Merge conflict/i.test(raw)) {
          throw new GitConflictError(
            '该提交之后的改动与删除操作存在内容冲突，无法自动合并。请先处理相关改动后再重试',
          );
        }
        throw new Error(raw || '删除历史失败');
      }

      return {
        dropped: target,
        head: (await git.revparse(['HEAD'])).trim(),
        pushed,
      };
    });
  }

  /** 取当前配置的分支名（默认 main） */
  async getBranch() {
    return (await this._getSetting(SETTING_KEYS.BRANCH)) || 'main';
  }

  /** 取本地 HEAD 的 commit hash（尚无提交时返回空字符串） */
  async getHeadHash() {
    if (!this.isReady() || !this._git) return '';
    try {
      return (await this._git.revparse(['HEAD'])).trim();
    } catch (e) {
      return '';
    }
  }

  /**
   * 把仓库回滚到指定提交（供上层在多步操作失败时调用）
   * @returns {Promise<boolean>} 是否回滚成功
   */
  async rollbackTo(commitHash, branch) {
    if (!this.isReady() || !this._git) return false;
    const br = branch || (await this.getBranch());
    // 注意：不能用 _enqueue —— 该方法常在外层 git 任务内被调用，
    // 入队会排到外层任务之后，而外层正等待它返回，导致死锁
    return this._rollbackTo(this._git, commitHash, br);
  }

  /**
   * 清空某个文件（书评）的全部历史：从所有提交中移除该文件，保留当前版本。
   * @param {string} relativePath - 相对仓库根目录的文件路径
   * @param {Object} options
   * @param {boolean} options.push - 是否强推远端
   */
  async purgeFileHistory(relativePath, { push = false } = {}) {
    if (!this.isReady()) {
      throw new Error('Git 仓库尚未初始化');
    }
    return this._enqueue('purge', async (git) => {
      const branch = (await this._getSetting(SETTING_KEYS.BRANCH)) || 'main';
      // filter-branch 自身要求工作区干净，无法在脏工作区上重写历史
      const status = await git.status();
      if (!status.isClean()) {
        throw new Error('工作区有未提交的变更，请先同步或保存后再清空历史');
      }

      // filter-branch 会重写全部历史，失败时需回滚，避免仓库停留在中间状态
      const headHash = (await git.revparse(['HEAD'])).trim();
      let pushed = false;
      try {
        // index-filter：在每个提交中移除该文件；--prune-empty 丢弃因此变空的提交
        const rmCmd = `git rm --cached --ignore-unmatch '${String(relativePath).replace(/'/g, "\\'")}'`;
        await git.raw(['filter-branch', '--force', '--index-filter', rmCmd, '--prune-empty', '--', branch]);

        // 清理 filter-branch 产生的备份引用与 reflog
        await git.raw(['update-ref', '-d', `refs/original/refs/heads/${branch}`]).catch(() => {});
        await git.raw(['reflog', 'expire', '--expire=now', '--all']).catch(() => {});
        await git.raw(['gc', '--prune=now', '--quiet']).catch(() => {});

        if (push) {
          pushed = await this._pushForceWithLease(git, branch);
        }
      } catch (err) {
        await this._rollbackTo(git, headHash, branch);
        if (err instanceof GitConflictError || err instanceof GitBadRequestError || err instanceof GitNotFoundError) {
          throw err;
        }
        const raw = err?.message || '';
        if (/CONFLICT|could not apply|Merge conflict/i.test(raw)) {
          throw new GitConflictError('清空历史过程中出现内容冲突，无法自动完成。请先处理相关改动后再重试');
        }
        throw new Error(raw || '清空历史失败');
      }
      return { purged: relativePath, pushed };
    });
  }

  /**
   * 强推当前分支到远端（重写历史后同步删除远端记录）
   *
   * 安全前提：远端当前 hash 必须是「本地已知的提交」——即它是本地 HEAD 的祖先。
   * 否则说明远端存在本地不知道的新提交（他人推送或本地未拉取），中止推送以免覆盖。
   *
   * 另：仓库 remote 配置为裸 URL（无命名 remote），refs/remotes/* 为空，
   * 不带期望值的 --force-with-lease 会被 git 一律判为 stale info 而拒绝，
   * 因此这里用「祖先校验 + --force」替代，语义更明确。
   */
  async _pushForceWithLease(git, branch, expectKnown = '') {
    const token = await this._getSetting(SETTING_KEYS.TOKEN);
    const repoUrl = await this._getSetting(SETTING_KEYS.REPO_URL);
    if (!token || !repoUrl) {
      throw new Error('未配置仓库地址或 Token，无法强推');
    }
    await this._assertRemoteIsKnown(git, repoUrl, token, branch, expectKnown);
    await this._pushWithFallback(git, branch, { '--force': null });
    await userSettingsService.saveSetting(0, SETTING_KEYS.LAST_SYNC_AT, new Date().toISOString());
    await userSettingsService.saveSetting(0, SETTING_KEYS.LAST_ERROR, '');
    await this._maybeGc();
    return true;
  }

  /**
   * 查询远端指定分支的当前 hash（实时查询，不使用测速缓存）
   *
   * 注意：此处不能用 selectFastestRemote() 的缓存结果 —— 该缓存有 30s TTL，
   * 而本方法服务于「强推前的安全校验」，必须反映远端此刻的真实状态，
   * 否则刚推送成功后紧接着的第二次操作会因读到过期 hash 而被误判为「远端已被更新」。
   * @returns {string|null} 远端 hash（分支不存在时为空字符串）；查询失败返回 null
   */
  async _getRemoteBranchHash(git, repoUrl, token, branch) {
    try {
      const out = await withTimeout(
        git.listRemote([this._buildAuthedUrl(repoUrl, token), `refs/heads/${branch}`]),
        NETWORK_TIMEOUT_MS,
        '查询远端分支状态超时',
      );
      // 输出形如 "<hash>\trefs/heads/main"，分支不存在时为空字符串
      return String(out || '').trim().split('\t')[0].trim();
    } catch (_) {
      return null;
    }
  }

  /**
   * 校验远端分支当前状态是否为「本地已知」，防止强推覆盖他人提交。
   *
   * 两种模式：
   *   1) expectKnown 为空（普通提交后强推）：远端 HEAD 必须是本地 HEAD 的祖先，
   *      即本地已包含远端全部提交。
   *   2) expectKnown 非空（重写历史后强推）：本地 HEAD 是全新构造的，与远端无祖先关系，
   *      因此改为要求远端 HEAD 严格等于 expectKnown（重写操作开始前记录的本地 HEAD）。
   *
   * 远端分支不存在（首次推送）时均视为安全。
   * 校验不通过统一抛 GitConflictError（HTTP 409）：
   * 这属于「需用户先同步再重试」的可恢复情况，不应作为服务端故障（500）上报。
   * @throws {GitConflictError} 校验不通过时抛出
   */
  async _assertRemoteIsKnown(git, repoUrl, token, branch, expectKnown = '') {
    const remoteHash = await this._getRemoteBranchHash(git, repoUrl, token, branch);
    if (remoteHash === null) {
      throw new GitConflictError('无法获取远端分支当前状态，为避免覆盖他人提交，已中止操作，请稍后重试');
    }
    // 远端分支不存在：允许创建
    if (remoteHash === '') return;

    if (expectKnown) {
      if (remoteHash === expectKnown) return;
      throw new GitConflictError('远端已被其他改动更新，请先拉取后再操作，以免覆盖他人内容');
    }

    const localHead = (await git.revparse(['HEAD'])).trim();
    if (remoteHash === localHead) return;
    // 远端 hash 是本地 HEAD 的祖先 → 本地已包含远端全部提交，可安全覆盖
    try {
      await git.raw(['merge-base', '--is-ancestor', remoteHash, localHead]);
      return;
    } catch (_) {
      // 非 0 退出码表示不是祖先
    }
    throw new GitConflictError('远端存在本地尚未同步的新提交，请先拉取后再操作，以免覆盖他人内容');
  }

  /**
   * 查询本地已提交但尚未推送到远端的 commit 列表
   * 通过 ls-remote 比对远端分支 HEAD 与本地 HEAD
   */
  async getUnpushedCommits() {
    if (!this.isReady() || !this._git) return { known: false, count: 0, commits: [] };
    const repoUrl = await this._getSetting(SETTING_KEYS.REPO_URL);
    const token = await this._getSetting(SETTING_KEYS.TOKEN);
    const branch = (await this._getSetting(SETTING_KEYS.BRANCH)) || 'main';
    if (!repoUrl || !token) return { known: false, count: 0, commits: [] };
    let speedResults = [];
    try {
      return await this._enqueue('unpushed', async (git) => {
        // 测速选路：原始地址 + 镜像并行测速，取最快（并复用其 ls-remote 输出）
        const fast = await this.selectFastestRemote();
        speedResults = fast?.results || [];
        if (!fast || !fast.selected || !fast.remoteHash) {
          return {
            known: false, count: 0, commits: [],
            error: fast ? '所有远端地址均不可达' : '未配置仓库地址或 Token',
            speedTest: fast?.results || [],
          };
        }
        const remoteHash = fast.remoteHash;
        const localHash = (await git.revparse(['HEAD'])).trim();
        if (!remoteHash || remoteHash === localHash) {
          return { known: true, count: 0, commits: [], via: fast.selectedUrl, speedTest: fast.results };
        }
        let commits = [];
        try {
          const log = await git.log({ from: remoteHash, to: 'HEAD' });
          commits = (log.all || []).map((c) => ({
            hash: c.hash.slice(0, 7),
            date: c.date,
            message: c.message,
          }));
        } catch (e) {
          // 浅克隆下远端哈希不在本地历史：fetch 更新引用后用 rev-list 统计
          try {
            await git.fetch(fast.selected, branch, { '--depth': '50' });
          } catch {}
          try {
            const count = parseInt(
              (await git.raw(['rev-list', '--count', `${remoteHash}..HEAD`])).trim(), 10,
            ) || 0;
            if (count > 0) {
              const log = await git.log({ maxCount: count });
              commits = (log.all || []).map((c) => ({
                hash: c.hash.slice(0, 7),
                date: c.date,
                message: c.message,
              }));
            }
          } catch {
            throw new Error('无法比对本地与远端历史（浅克隆），请先执行一次拉取');
          }
        }
        return { known: true, count: commits.length, commits, via: fast.selectedUrl, speedTest: fast.results };
      });
    } catch (e) {
      // 网络不通等情况：无法判断，不阻塞预览
      return { known: false, count: 0, commits: [], error: e.message, speedTest: speedResults };
    }
  }

  // ---------- 版本历史 ----------

  /**
   * 获取某文件的提交历史
   * @param {string} relativePath - 相对仓库根目录的文件路径
   * @param {number} maxCount - 最多返回条数
   * @returns {Array<{hash, date, message, author}>}
   */
  async getFileHistory(relativePath, maxCount = 50) {
    if (!this.isReady()) throw new Error('Git 仓库尚未初始化');
    return this._enqueue('log', async (git) => {
      const log = await git.log({ file: relativePath, maxCount });
      if (!log || !log.all) return [];
      return log.all.map(entry => ({
        hash: entry.hash,
        date: entry.date,
        message: entry.message,
        author: entry.author_name,
      }));
    });
  }

  /**
   * 读取某个 commit 中某文件的内容
   * @param {string} commitHash
   * @param {string} relativePath
   * @returns {string} 文件内容
   */
  async showFileAtCommit(commitHash, relativePath) {
    if (!this.isReady()) throw new Error('Git 仓库尚未初始化');
    return this._enqueue('show', async (git) => {
      const result = await git.show([`${commitHash}:${relativePath}`]);
      return result;
    });
  }

  /**
   * 对比两个 commit 之间某文件的差异
   * @param {string} oldHash
   * @param {string} newHash
   * @param {string} relativePath
   * @returns {string} git diff 文本
   */
  async diffFile(oldHash, newHash, relativePath) {
    if (!this.isReady()) throw new Error('Git 仓库尚未初始化');
    return this._enqueue('diff', async (git) => {
      const diff = await git.diff([oldHash, newHash, '--', relativePath]);
      return diff;
    });
  }

  // ---------- 内部工具 ----------

  async _ensureRepo(repoUrl, branch) {
    fs.mkdirSync(this._repoDir, { recursive: true });
    const dotGit = path.join(this._repoDir, '.git');

    if (!fs.existsSync(dotGit)) {
      const token = await this._getSetting(SETTING_KEYS.TOKEN);
      const cloneUrl = token ? this._buildAuthedUrl(repoUrl, token) : repoUrl;
      console.log('[GitService] 克隆仓库（完整历史）:', maskUrl(repoUrl));
      this._git = simpleGit();
      // 克隆到 _repoDir 的父目录临时名，避免空目录报错
      const parent = path.dirname(this._repoDir);
      const tmpName = path.basename(this._repoDir) + '.clone-' + Date.now();
      const tmpPath = path.join(parent, tmpName);
      const cloneArgs = ['--branch', branch];
      try {
        await this._git.clone(cloneUrl, tmpPath, cloneArgs);
        fs.renameSync(tmpPath, this._repoDir);
      } catch (err) {
        // 若分支不存在则用默认分支克隆
        if (err && err.message && (err.message.includes('Remote branch') || err.message.includes('not found'))) {
          if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { recursive: true, force: true });
          await this._git.clone(cloneUrl, tmpPath, []);
          fs.renameSync(tmpPath, this._repoDir);
        } else {
          throw err;
        }
      }
      this._git = simpleGit(this._repoDir);
    } else {
      this._git = simpleGit(this._repoDir);
      // 若本地是浅克隆（之前用了 --depth 1），自动补全历史
      await this._unshallowIfNeeded();
    }

    // 应用代理（HTTP_PROXY 环境变量 + git http.proxy 配置）
    await this._applyProxy();

    await this._applyAuthor();
    this._ready = true;
  }

  /**
   * 如果当前仓库是浅克隆（shallow），执行 fetch --unshallow 补全完整历史
   */
  async _unshallowIfNeeded() {
    try {
      if (!this._git) return;
      const shallowFile = path.join(this._repoDir, '.git', 'shallow');
      if (!fs.existsSync(shallowFile)) return; // 不是浅克隆
      const repoUrl = await this._getSetting(SETTING_KEYS.REPO_URL);
      const token = await this._getSetting(SETTING_KEYS.TOKEN);
      if (!repoUrl || !token) return; // 未配置远端则暂不补全
      const branch = (await this._getSetting(SETTING_KEYS.BRANCH)) || 'main';
      const authedUrl = this._buildAuthedUrl(repoUrl, token);
      console.log('[GitService] 检测到浅克隆，正在补全完整历史 (--unshallow)...');
      await withTimeout(
        this._git.fetch(authedUrl, branch, { '--unshallow': null }),
        60 * 1000,
        '补全历史超时，可后续手动拉取',
      );
      console.log('[GitService] 历史补全完成');
    } catch (e) {
      // unshallow 失败不阻塞启动，可能是网络问题，后续拉取会再试
      console.warn('[GitService] 自动补全历史失败（不影响功能）:', e.message);
    }
  }

  /**
   * 应用 HTTP 代理：同时设置 git config http.proxy 和进程环境变量，供 fetch/push/ls-remote 使用
   */
  async _applyProxy() {
    if (!this._git) return;
    const proxy = await this._getSetting(SETTING_KEYS.PROXY);
    const proxyVal = typeof proxy === 'string' ? proxy.trim() : '';
    try {
      if (proxyVal) {
        await this._git.addConfig('http.proxy', proxyVal, false, 'local');
        await this._git.addConfig('https.proxy', proxyVal, false, 'local');
        process.env.HTTP_PROXY = proxyVal;
        process.env.HTTPS_PROXY = proxyVal;
        process.env.http_proxy = proxyVal;
        process.env.https_proxy = proxyVal;
        console.log('[GitService] 已启用 HTTP 代理:', maskUrl(proxyVal));
      } else {
        // 清除旧代理配置
        try { await this._git.raw(['config', '--unset', 'http.proxy']).catch(() => {}); } catch {}
        try { await this._git.raw(['config', '--unset', 'https.proxy']).catch(() => {}); } catch {}
        delete process.env.HTTP_PROXY;
        delete process.env.HTTPS_PROXY;
        delete process.env.http_proxy;
        delete process.env.https_proxy;
      }
    } catch (e) {
      console.warn('[GitService] 设置代理失败:', e.message);
    }
  }

  /**
   * push 后触发一次轻量 gc，压缩松散对象（不频繁，每次同步一次）
   */
  async _maybeGc() {
    try {
      if (!this._git) return;
      await this._git.raw(['gc', '--auto', '--quiet']).catch(() => {});
    } catch {}
  }

  async _ensureSafeDir(repoDir) {
    try {
      const globalGit = simpleGit();
      await globalGit.addConfig('safe.directory', repoDir, true, 'global');
    } catch {}
  }

  async _applyAuthor() {
    if (!this._git) return;
    const name = await this._getSetting(SETTING_KEYS.USER_NAME) || 'QCBookLog';
    const email = await this._getSetting(SETTING_KEYS.USER_EMAIL) || 'q cbooklog@local';
    // 先设置全局默认（commit 时若 local 未生效也不会报 author unknown）
    try {
      const globalGit = simpleGit();
      await globalGit.addConfig('user.name', name, false, 'global');
      await globalGit.addConfig('user.email', email, false, 'global');
    } catch {}
    try {
      await this._git.addConfig('user.name', name, false, 'local');
      await this._git.addConfig('user.email', email, false, 'local');
    } catch {}
  }

  _buildAuthedUrl(repoUrl, token) {
    // repoUrl 形如 https://github.com/owner/repo.git
    // 替换为 https://x-access-token:TOKEN@github.com/owner/repo.git
    const m = repoUrl.match(/^https?:\/\/([^/]+)\/(.+)$/);
    if (!m) return repoUrl;
    const host = m[1];
    const rest = m[2];
    // 若 URL 里已经包含 token（不太可能），先剔除
    if (host.includes('@')) {
      const parts = host.split('@');
      return `https://x-access-token:${token}@${parts[1]}/${rest}`;
    }
    return `https://x-access-token:${token}@${host}/${rest}`;
  }

  /**
   * 规范化镜像地址列表：支持换行/逗号分隔的字符串或数组
   */
  _normalizeMirrors(mirrors) {
    const list = Array.isArray(mirrors) ? mirrors : String(mirrors || '').split(/[\n,]/);
    return list.map((s) => String(s).trim()).filter(Boolean);
  }

  async _getMirrors() {
    const raw = await this._getSetting(SETTING_KEYS.MIRRORS);
    return this._normalizeMirrors(raw);
  }

  /**
   * 对单个远端做 ls-remote 测速（并行调用）
   * @returns {{ url, ok, ms, error, out }}
   */
  async _testRemoteSpeed(repoUrl, token, branch) {
    const authedUrl = this._buildAuthedUrl(repoUrl, token);
    const start = Date.now();
    try {
      const git = this._git || simpleGit(this._repoDir);
      const out = await withTimeout(git.raw(['ls-remote', authedUrl, branch]), NETWORK_TIMEOUT_MS, '测速超时');
      return { url: repoUrl, ok: true, ms: Date.now() - start, error: null, out };
    } catch (e) {
      return { url: repoUrl, ok: false, ms: Date.now() - start, error: e.message, out: '' };
    }
  }

  /**
   * 对原始地址 + 所有镜像并行测速，选出最快的可用远端。
   * 结果短缓存（30s），避免一次同步动作内重复测速。
   * @returns {{ selected, results, fallback }} selected 为带 token 的 URL
   */
  async selectFastestRemote() {
    const repoUrl = await this._getSetting(SETTING_KEYS.REPO_URL);
    const token = await this._getSetting(SETTING_KEYS.TOKEN);
    const branch = (await this._getSetting(SETTING_KEYS.BRANCH)) || 'main';
    if (!repoUrl || !token) return null;

    const cacheTtl = 30 * 1000;
    const mirrors = await this._getMirrors();
    const cacheKey = `${repoUrl}|${branch}|${mirrors.join(',')}`;
    if (this._speedCache && this._speedCache.key === cacheKey
      && Date.now() - this._speedCache.at < cacheTtl) {
      return this._speedCache.value;
    }

    const candidates = [repoUrl, ...mirrors.filter((m) => m !== repoUrl)];
    const results = await Promise.all(candidates.map((u) => this._testRemoteSpeed(u, token, branch)));

    const okList = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
    const best = okList[0] || null;
    // 直接复用测速成功的 ls-remote 输出，避免二次网络请求
    const remoteHash = best ? (best.out.trim().split('\t')[0] || '').trim() : '';
    const value = {
      selected: best ? this._buildAuthedUrl(best.url, token) : null,
      selectedUrl: best ? best.url : null,
      remoteHash,
      results: results.map((r) => ({ url: maskUrl(r.url), ok: r.ok, ms: r.ms, error: r.error })),
    };
    this._speedCache = { at: Date.now(), key: cacheKey, value };
    return value;
  }

  /**
   * 推送：优先用测速最快的地址，失败时回退到原始仓库地址（每次 push 有 60s 超时保护）
   */
  async _pushWithFallback(git, branch, pushOptions) {
    const token = await this._getSetting(SETTING_KEYS.TOKEN);
    const repoUrl = await this._getSetting(SETTING_KEYS.REPO_URL);
    if (!token || !repoUrl) {
      throw new Error('未配置仓库地址或 Token，无法 push');
    }
    const fast = await this.selectFastestRemote();
    const originalAuthed = this._buildAuthedUrl(repoUrl, token);
    const primaryUrl = fast?.selected || originalAuthed;

    const doPush = (url, opts) => withTimeout(
      git.push(url, branch, opts),
      PUSH_TIMEOUT_MS,
      '推送超时（60 秒未完成，网络可能不可达）',
    );

    const errors = [];
    try {
      return await doPush(primaryUrl, pushOptions);
    } catch (err) {
      const msg = err && err.message ? err.message : '';
      errors.push(msg);
      if (msg.includes('upstream') || msg.includes('refspec')) {
        try {
          return await doPush(primaryUrl, Object.keys(pushOptions || {}));
        } catch (err2) {
          errors.push(err2.message);
        }
      }
      // 镜像通常不支持 push：换回原始地址重试一次
      if (primaryUrl !== originalAuthed) {
        console.warn('[GitService] 镜像推送失败，回退原始地址重试:', maskUrl(repoUrl));
        try {
          return await doPush(originalAuthed, pushOptions);
        } catch (err2) {
          errors.push(err2.message);
        }
      }
      const isNetwork = errors.some((m) => /unable to access|Could not resolve|Couldn't connect|timed out|超时/.test(m));
      throw new Error(
        (isNetwork ? '推送失败：网络不可达（若已配置镜像，注意多数镜像仅支持下载、不支持推送）: ' : '推送失败: ')
        + errors[errors.length - 1],
      );
    }
  }

  async _getSetting(key) {
    try {
      return await userSettingsService.getSetting(0, key);
    } catch {
      return null;
    }
  }
}

export default new GitService();
export { SETTING_KEYS as GIT_SETTINGS };
