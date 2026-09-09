import type { RuleSpec, Slice, SliceFile } from './types.ts';
import { runScan } from './lanes/deterministic.ts';
import { sha } from './hash.ts';

export interface ProveResult {
  rule: string;
  cases: { name: string; expect: 'red' | 'green'; got: 'red' | 'green'; ok: boolean; detail?: string }[];
  /** red 를 한 번이라도 시연했는가. 이게 false 면 그 게이트는 `unproven` 이다. */
  demonstratesRed: boolean;
  ok: boolean;
}

/**
 * red-first 증명. 픽스처로 룰이 **실패를 낼 수 있음**을 보인다.
 * 통과만 하는 게이트는 통과를 증명하지 못한다 — 아무것도 안 하는 게이트와
 * 구별되지 않기 때문이다. 이것이 하네스의 `--selftest` 를 프레임워크 계약으로
 * 승격한 자리다.
 */
export async function prove(spec: RuleSpec): Promise<ProveResult> {
  const cases: ProveResult['cases'] = [];
  for (const c of spec.prove ?? []) {
    const files: SliceFile[] = Object.entries(c.files).map(([path, v]) =>
      typeof v === 'string' ? { path, text: v } : { path, ...v },
    );
    const slice: Slice = {
      kind: 'tree',
      files,
      data: c.data ?? null,
      meta: { fixture: c.name },
      hash: sha(JSON.stringify([c.files, c.data ?? null])),
    };
    try {
      const scan = await runScan(spec, slice, { ...(spec.params ?? {}), ...(c.params ?? {}) });
      // 픽스처 판정에서 후보는 red 로 센다 — 판정자 없이도 "탐색이 걸린다" 를 증명한다.
      const hit = scan.findings.length + scan.candidates.length > 0;
      const got: 'red' | 'green' = hit ? 'red' : 'green';
      const codeOk =
        !c.code ||
        scan.findings.some((f) => f.code === c.code) ||
        scan.candidates.some((x) => x.code === c.code);
      cases.push({
        name: c.name,
        expect: c.expect,
        got,
        ok: got === c.expect && codeOk,
        ...(codeOk ? {} : { detail: `기대한 code '${c.code}' 가 나오지 않았다` }),
      });
    } catch (e) {
      cases.push({
        name: c.name,
        expect: c.expect,
        got: 'green',
        ok: false,
        detail: (e as Error).message,
      });
    }
  }
  const demonstratesRed = cases.some((c) => c.expect === 'red' && c.ok);
  return {
    rule: spec.id,
    cases,
    demonstratesRed,
    ok: cases.length > 0 && cases.every((c) => c.ok) && demonstratesRed,
  };
}
