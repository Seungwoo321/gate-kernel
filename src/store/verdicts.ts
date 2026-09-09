import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GateState, RuleSpec, Slice, Verdict } from '../types.ts';
import { isExpired } from '../masks.ts';

const VERDICT_DIR = 'verdicts';

export function verdictPath(storeDir: string, ruleId: string): string {
  return join(storeDir, VERDICT_DIR, `${ruleId}.json`);
}

export function load(storeDir: string, ruleId: string): Verdict | null {
  const p = verdictPath(storeDir, ruleId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Verdict;
  } catch {
    return null;
  }
}

export function save(storeDir: string, v: Verdict): void {
  mkdirSync(join(storeDir, VERDICT_DIR), { recursive: true });
  writeFileSync(verdictPath(storeDir, v.rule), `${JSON.stringify(v, null, 2)}\n`, 'utf8');
}

export function loadAll(storeDir: string): Verdict[] {
  const dir = join(storeDir, VERDICT_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as Verdict);
}

/**
 * 이 룰이 한 번이라도 red 를 낸 적이 있는가. `green` 의 전제다.
 * 시연 경로는 둘이고 둘 다 유효하다 — 픽스처(`prove`)와 실제 실행(`run`).
 * 픽스처를 인정하지 않으면, 실무에서 아직 위반이 없는 정상 게이트가 영원히
 * `unproven` 으로 남아 상태값이 의미를 잃는다.
 */
export function hasProvenRed(storeDir: string, ruleId: string): boolean {
  const p = join(storeDir, 'proven', `${ruleId}`);
  return existsSync(p);
}

export function markProvenRed(storeDir: string, ruleId: string, by: 'prove' | 'run'): void {
  mkdirSync(join(storeDir, 'proven'), { recursive: true });
  writeFileSync(join(storeDir, 'proven', ruleId), `${by} ${new Date().toISOString()}\n`, 'utf8');
}

/**
 * 저장된 판정이 지금 대상에 대해 여전히 유효한가.
 * 네 축(기준·탐색·면제·대상) 중 하나라도 어긋나면 `stale` 이고, **stale 은 green 이
 * 아니다.** 면제가 축인 이유: 방금 적은 마스크가 대상이 바뀔 때까지 적용되지 않으면
 * "다음부터 안 묻는다" 는 약속이 지켜지지 않는다.
 * 테스트 프레임워크에 이 상태가 없는 이유는 재실행이 싸기 때문이다 — 판정자
 * 호출은 비싸서 캐시가 필수고, 캐시가 있으면 staleness 는 일급 상태가 된다.
 */
export function stalenessOf(
  prev: Verdict | null,
  spec: RuleSpec,
  slice: Slice,
  now: Date = new Date(),
): { fresh: boolean; reason?: string } {
  if (!prev) return { fresh: false, reason: 'no-verdict' };
  if (prev.criterionRev !== spec.criterionRev) return { fresh: false, reason: 'criterion-changed' };
  if (prev.scanRev !== spec.scanRev) return { fresh: false, reason: 'scan-changed' };
  if (prev.maskRev !== spec.maskRev) return { fresh: false, reason: 'mask-changed' };
  if (prev.subjectHash !== slice.hash) return { fresh: false, reason: 'subject-changed' };
  // 기한 만료는 아무것도 안 바뀌어도 일어난다. 이 검사가 없으면 마스크가 살아
  // 있을 때 저장된 green 이 만료 후에도 그대로 재생돼, `until` 이 영구 면제가 된다.
  const at = new Date(prev.at);
  if ((spec.mask ?? []).some((m) => isExpired(m, now) && !isExpired(m, at))) {
    return { fresh: false, reason: 'mask-expired' };
  }
  return { fresh: true };
}

export function stateOf(opts: {
  hasFindings: boolean;
  provenRed: boolean;
  broken?: string;
}): GateState {
  if (opts.broken) return 'broken';
  if (opts.hasFindings) return 'red';
  return opts.provenRed ? 'green' : 'unproven';
}
