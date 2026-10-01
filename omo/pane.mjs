import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export const PANE_LABEL = 'AI 사용량';

export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export const shellCommand = args => args.map(quote).join(' ');

function isFile(path) {
  try { return statSync(path).isFile(); }
  catch { return false; }
}

export function resolveBin(name, env = process.env) {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && isFile(join(dir, name))) return join(dir, name);
  }
  return null;
}

export function herdrSession(env = process.env) {
  if (env.HERDR_ENV !== '1' || !env.HERDR_PANE_ID || !env.HERDR_SOCKET_PATH) return false;
  if (!existsSync(env.HERDR_SOCKET_PATH)) return false;
  return resolveBin('herdr', env) !== null;
}

export function createHerdr(env = process.env) {
  return async (...args) => {
    const bin = resolveBin('herdr', env);
    if (!bin) throw new Error('herdr 실행 파일을 찾을 수 없음');
    const { stdout } = await execute(bin, ['pane', ...args], { env, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
    if (!stdout.trim()) return {};
    const reply = JSON.parse(stdout);
    if (reply.error) throw new Error(reply.error.message ?? JSON.stringify(reply.error));
    return reply.result;
  };
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
}

export function isUsagePane(pane) {
  return pane?.label === PANE_LABEL || pane?.title === PANE_LABEL;
}

export class UsagePane {
  constructor({ herdr, parentPane, socket, stateDir, cwd, command, direction = 'down', ratio = 0.75 }) {
    Object.assign(this, { herdr, parentPane, socket, stateDir, cwd, command, direction, ratio });
  }

  recordFile(tab) {
    const key = createHash('sha256').update(JSON.stringify([this.socket, tab ?? this.parentPane])).digest('hex').slice(0, 24);
    return join(this.stateDir, `${key}.pane.json`);
  }

  async ensure(force) {
    const panes = (await this.herdr('list'))?.panes ?? [];
    const tab = panes.find(p => p.pane_id === this.parentPane)?.tab_id ?? null;
    const live = panes.find(p => isUsagePane(p) && p.pane_id !== this.parentPane && (!tab || p.tab_id === tab));
    if (live) return { paneId: live.pane_id, opened: false };
    const record = this.recordFile(tab);
    if (!force && readJson(record)) return { paneId: null, opened: false };
    writeJson(record, { attempted: true });
    const result = await this.herdr('split', '--pane', this.parentPane, '--direction', this.direction,
      '--ratio', String(this.ratio), '--cwd', this.cwd, '--no-focus');
    const paneId = result?.pane?.pane_id;
    if (!paneId) throw new Error('herdr가 새 pane id를 돌려주지 않음');
    writeJson(record, { paneId, ready: false });
    await this.herdr('rename', paneId, PANE_LABEL);
    await this.herdr('run', paneId, this.command(paneId));
    writeJson(record, { paneId, ready: true });
    return { paneId, opened: true };
  }
}
