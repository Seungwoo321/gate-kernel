#!/usr/bin/env node
/**
 * Stop — 판정 대기를 남긴 채 턴을 끝내지 못하게 막는다.
 *
 * 판정 요청이 남았다는 건 "아직 결론이 아니다" 라는 뜻이다(exit 20). 그대로
 * 세션을 끝내면 그 게이트는 통과도 실패도 아닌 채로 잊히고, 다음 사람은
 * 그것을 초록으로 읽는다. fail-closed 를 턴 경계에까지 적용하는 훅이다.
 *
 * 한 번만 막는다 — `stop_hook_active` 가 켜져 있으면 통과시킨다(루프 방지).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const input = await read();
if (input?.stop_hook_active) process.exit(0);

const cwd = process.cwd();
const hasConfig = ['gate.config.mjs', 'gate.config.js', 'gate.config.ts'].some((f) =>
  existsSync(join(cwd, f)),
);
if (!hasConfig) process.exit(0);

let pending = [];
try {
  // `gate pending` 은 대기가 있으면 20 으로 끝난다 — 종료 코드는 판정 채널이지
  // 에러 채널이 아니다. nonzero 를 실패로 접으면 이 훅은 영원히 안 켜진다.
  let stdout;
  try {
    // `--no-install` — session-status.mjs 와 같은 이유로 레지스트리 폴백을 막는다.
    stdout = execFileSync('npx', ['--no-install', 'gate', 'pending'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    if (typeof e?.stdout !== 'string' || !e.stdout.trim()) throw e;
    stdout = e.stdout;
  }
  pending = JSON.parse(stdout);
} catch {
  // 조회 자체가 안 되는 것으로 턴을 막지는 않는다 — 훅이 작업을 인질로 잡으면 곧 꺼진다.
  process.exit(0);
}

if (!Array.isArray(pending) || pending.length === 0) process.exit(0);

const ids = [...new Set(pending.map((p) => p.rule))].join(', ');
process.stdout.write(
  JSON.stringify({
    decision: 'block',
    reason:
      `판정 대기가 ${pending.length}건 남았다 (${ids}). 판정 대기는 통과가 아니다.\n` +
      '`gate-run` 스킬 2단계대로 요청마다 `gate-judge` 서브에이전트를 띄워 verdict 파일을 쓰게 하고, ' +
      '`npx gate run` 을 다시 돌려 결론을 낸 뒤 끝내라. ' +
      '판정을 네가 직접 내리지 않는다(생산자 ≠ 검증자).',
  }),
);

async function read() {
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}
