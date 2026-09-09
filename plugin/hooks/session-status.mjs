#!/usr/bin/env node
/**
 * SessionStart — 게이트가 있는 프로젝트면 그 상태를 세션 시작 시 주입한다.
 *
 * 게이트를 "물어봐야 보이는 것" 으로 두면 결국 안 돌린다. 상태를 세션 앞단에
 * 놓는 것이 게이트를 운영 자산으로 만드는 최소 조건이다.
 * 게이트가 없는 프로젝트에서는 아무것도 하지 않는다(침묵이 기본값).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const cwd = process.cwd();
const hasConfig = ['gate.config.mjs', 'gate.config.js', 'gate.config.ts'].some((f) =>
  existsSync(join(cwd, f)),
);
if (!hasConfig) process.exit(0);

let rows;
try {
  rows = JSON.parse(gate(['status', '--json'], cwd));
} catch (e) {
  // status 자체가 안 도는 것도 정보다 — 조용히 통과시키지 않는다.
  emit(`gate-kernel: 게이트 설정은 있으나 \`gate status\` 가 실패했다. 게이트 상태는 현재 미확인이다.\n${String(e?.message ?? e).slice(0, 400)}`);
  process.exit(0);
}

if (!Array.isArray(rows) || rows.length === 0) process.exit(0);

const by = (s) => rows.filter((r) => r.state === s);
const lines = [
  `# 게이트 상태 (${rows.length}개)`,
  '',
  ...rows.map((r) => `- ${mark(r.state)} \`${r.id}\` — ${r.state}${r.findings ? ` (${r.findings}건)` : ''}`),
  '',
];

const red = by('red');
const stale = by('stale');
const broken = by('broken');
const unproven = by('unproven');

if (red.length) lines.push(`red 가 ${red.length}개 있다. 이 상태로 작업을 완료로 보고하지 않는다.`);
if (stale.length) lines.push(`stale 이 ${stale.length}개 있다 — 기준·탐색·면제·대상 중 하나가 바뀌어 과거 판정이 무효다. 통과가 아니다.`);
if (broken.length) lines.push(`broken 이 ${broken.length}개 있다 — 판정 불가는 통과가 아니다.`);
if (unproven.length) lines.push(`unproven 이 ${unproven.length}개 있다 — 실패를 시연한 적이 없어 초록이 아니라 "아직 모름" 이다.`);
lines.push('', '실행은 `gate-run` 스킬을, 새 게이트 작성은 `gate-author` 스킬을 따른다.');

emit(lines.join('\n'));

/**
 * 종료 코드는 판정 채널이지 에러 채널이 아니다 — `status` 는 red 가 있으면 1 로 끝난다.
 * 그래서 nonzero 를 실패로 접지 않고 stdout 을 그대로 회수한다. 진짜 실패는
 * 프로세스를 못 띄우거나 stdout 이 JSON 이 아닌 경우뿐이다.
 */
function gate(args, cwd) {
  try {
    // `--no-install` 이 필수다 — 없으면 로컬 bin 이 없을 때 npx 가 레지스트리의
    // 동명 패키지(`gate`, 무관한 async 유틸)를 받아 실행하려 든다. 훅은 stdin 을
    // 닫고 실패를 흡수하므로 그 폴백이 조용히 일어난다.
    return execFileSync('npx', ['--no-install', 'gate', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    if (typeof e?.stdout === 'string' && e.stdout.trim()) return e.stdout;
    throw e;
  }
}

function mark(s) {
  return { green: '✓', red: '✗', stale: '~', unproven: '?', skipped: '–', broken: '!' }[s] ?? '?';
}

function emit(additionalContext) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }),
  );
}
