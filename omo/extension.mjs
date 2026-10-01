import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsagePane, createHerdr, herdrSession, resolveBin, shellCommand } from './pane.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'src', 'cli.ts');
const CONFIG = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'aiusage', 'config.json');
const STATE_DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'aiusage', 'panes');

export function paneConfig(path = CONFIG) {
  let pane = {};
  try { pane = JSON.parse(readFileSync(path, 'utf8'))?.pane ?? {}; }
  catch { pane = {}; }
  const ratio = Number(pane.ratio);
  return {
    autoOpen: pane.autoOpen !== false,
    direction: pane.direction === 'right' ? 'right' : 'down',
    ratio: Number.isFinite(ratio) && ratio > 0.1 && ratio < 0.95 ? ratio : 0.75,
  };
}

export default function extension(pi) {
  if (!herdrSession()) return;
  let pane;

  pi.on('session_start', (_event, ctx) => {
    pane = undefined;
    if (ctx.hasUI === false) return;
    if (/[/\\]senpi-task[/\\]children[/\\]/.test(ctx.sessionManager.getSessionFile?.() ?? '')) return;
    const cfg = paneConfig();
    const bun = process.env.AIUSAGE_BUN ?? resolveBin('bun') ?? join(homedir(), '.bun', 'bin', 'bun');
    pane = new UsagePane({
      herdr: createHerdr(),
      parentPane: process.env.HERDR_PANE_ID,
      socket: process.env.HERDR_SOCKET_PATH,
      stateDir: STATE_DIR,
      cwd: ROOT,
      direction: cfg.direction,
      ratio: cfg.ratio,
      command: paneId => shellCommand([bun, CLI, '--close-pane', paneId, '--anchor', process.env.HERDR_PANE_ID]),
    });
    if (cfg.autoOpen) void pane.ensure(false).catch(error => ctx.ui.notify(`AI 사용량 pane: ${error.message}`, 'warning'));
  });

  pi.registerCommand('usage-pane', {
    description: 'AI 구독 사용량 pane 열기',
    handler: async (_args, ctx) => {
      if (!pane) return ctx.ui.notify('AI 사용량 pane은 herdr 안의 omo 세션에서만 열 수 있습니다', 'warning');
      try {
        const { opened } = await pane.ensure(true);
        ctx.ui.notify(opened ? 'AI 사용량 pane을 열었습니다' : 'AI 사용량 pane이 이미 열려 있습니다', 'info');
      } catch (error) {
        ctx.ui.notify(`AI 사용량 pane: ${error.message}`, 'warning');
      }
    },
  });
}
