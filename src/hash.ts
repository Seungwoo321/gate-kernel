import { createHash } from 'node:crypto';

export function sha(input: string, len = 16): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, len);
}

/** 함수의 소스를 해시한다 — 탐색 로직이 바뀌면 과거 판정은 stale 이 되어야 한다. */
export function fnRev(fn: unknown): string {
  if (typeof fn !== 'function') return 'none';
  return sha(fn.toString());
}

export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') {
      return typeof v === 'bigint' ? v.toString() : v;
    }
    if (v instanceof RegExp) return `re:${v.source}/${v.flags}`;
    if (seen.has(v)) throw new TypeError('stableStringify: 순환 참조');
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = walk((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}
