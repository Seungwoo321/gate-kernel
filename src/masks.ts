import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MaskSpec, RuleSpec } from './types.ts';
import { sha, stableStringify } from './hash.ts';

/**
 * 면제(마스크)는 **레포가 소유하고 리뷰를 통과해야 하는 결정**이다.
 *
 * 그래서 두 곳에서 온다. 게이트 저자가 룰 파일에 적는 `mask`(그 게이트가 원래
 * 틀리게 잡는 자리 — 게이트와 함께 배포된다)와, 이 레포가 자기 코드에 대해 적는
 * 마스크 파일이다. 후자를 캐시 디렉토리(`.gate`)에 두지 않는 이유가 핵심이다:
 * 캐시는 보통 gitignore 라서, 거기 쌓인 면제는 diff 에 안 나타나고 아무도 리뷰하지
 * 않는다. 리뷰되지 않는 면제는 게이트를 조용히 끄는 스위치와 같다.
 *
 * npm 으로 받은 게이트도 이 파일로 면제할 수 있다 — 남의 패키지 소스를 고칠 수는
 * 없기 때문이다.
 */
export const DEFAULT_MASK_FILE = 'gate.masks.json';

export type MaskFile = Record<string, MaskSpec[]>;

/**
 * 마스크 집합의 지문. `criterionRev`/`scanRev`/`subjectHash` 와 나란한 staleness 축이다.
 *
 * 별도 축인 이유: 마스크는 기준도 탐색도 대상도 아니라 **산출에 얹는 필터**라,
 * 셋 중 어디에 끼워 넣어도 거짓말이 된다. 그러면서도 캐시를 무효화하긴 해야 한다 —
 * 안 그러면 방금 적은 면제가 대상이 바뀔 때까지 적용되지 않아 "다음부터 안 묻는다"
 * 는 약속이 지켜지지 않는다.
 */
export function maskRev(masks: readonly MaskSpec[] | undefined): string {
  return sha(stableStringify([...(masks ?? [])]));
}

/** `YYYY-MM-DD` 또는 ISO 8601. 파싱 실패는 `null` 이고 등록에서 거부된다. */
export function parseUntil(v: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(v.trim())) return null;
  const d = new Date(v.trim().length === 10 ? `${v.trim()}T23:59:59.999Z` : v.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 만료된 마스크는 효력이 없다 — 결함이 되돌아온다(fail-closed). */
export function isExpired(m: MaskSpec, now: Date): boolean {
  if (!m.until) return false;
  const at = parseUntil(m.until);
  return at != null && now.getTime() > at.getTime();
}

export function maskFilePath(cwd: string, file: string = DEFAULT_MASK_FILE): string {
  return resolve(cwd, file);
}

export function loadMaskFile(cwd: string, file?: string): MaskFile {
  const p = maskFilePath(cwd, file);
  if (!existsSync(p)) return {};
  const raw = JSON.parse(readFileSync(p, 'utf8')) as MaskFile;
  return raw && typeof raw === 'object' ? raw : {};
}

export function saveMaskFile(cwd: string, data: MaskFile, file?: string): string {
  const p = maskFilePath(cwd, file);
  writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return p;
}

/**
 * 레포 마스크를 룰에 얹는다. `maskRev` 를 다시 계산하는 것이 이 함수의 본체다 —
 * 얹기만 하고 지문을 그대로 두면 캐시가 옛 판정을 그대로 재생한다.
 */
export function applyMaskFile(rules: RuleSpec[], file: MaskFile): RuleSpec[] {
  return rules.map((r) => {
    const extra = file[r.id];
    if (!extra?.length) return r;
    const mask = [...(r.mask ?? []), ...extra];
    return { ...r, mask, maskRev: maskRev(mask) };
  });
}
