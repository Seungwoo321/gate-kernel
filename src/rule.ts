import type { RuleDef, RuleSpec } from './types.ts';
import { fnRev, sha, stableStringify } from './hash.ts';
import { maskRev, parseUntil } from './masks.ts';

/**
 * 등록 시점에 거부하는 것들. 게이트 프레임워크의 값은 **작성 가능한 나쁜 게이트를
 * 줄이는 것**에서 나온다 — 런타임에 경고하는 대신 등록 자체를 실패시킨다.
 */
export class RuleDefinitionError extends Error {
  constructor(
    readonly ruleId: string,
    message: string,
  ) {
    super(`[${ruleId}] ${message}`);
    this.name = 'RuleDefinitionError';
  }
}

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function rule(id: string, def: RuleDef): RuleSpec {
  const fail = (m: string): never => {
    throw new RuleDefinitionError(id, m);
  };

  if (!ID_RE.test(id)) fail('룰 id 는 kebab-case 여야 한다');
  if (!def.criterion?.trim()) fail('`criterion` 은 필수다 — 이 게이트가 무엇을 보장하는지 한 문장');

  const hasDetect = def.detect != null;
  const hasScan = typeof def.scan === 'function';

  // 불변식: 결정적 좁히기 없는 게이트는 거부한다.
  // 좁히기가 없으면 판정자에게 레포 전체가 넘어가고, 그 순간 고정점이 사라진다.
  if (!hasDetect && !hasScan) {
    fail('`detect` 또는 `scan` 중 하나는 있어야 한다 — 결정적 좁히기 없는 게이트는 수렴하지 않는다');
  }

  // 불변식: 판정자를 쓰려면 왜 결정적으로 안 되는지를 적어야 한다.
  if (def.judge) {
    if (!def.judge.because?.trim()) {
      fail('`judge.because` 는 필수다 — 결정성이 있는데 판정자를 쓰면 고정점을 버리는 것이다');
    }
    if (!def.judge.ask?.trim() && !def.judge.contract) {
      fail('`judge.ask` 또는 `judge.contract` 중 하나는 있어야 한다');
    }
    // 판정자는 후보 위에서만 돈다. 후보를 만들 수 있는 건 scan 뿐이다.
    if (!hasScan) {
      fail('`judge` 를 쓰려면 `scan` 이 후보를 만들어야 한다 — detect 는 이미 결정된 결함만 낸다');
    }
  }

  for (const m of def.mask ?? []) {
    if (!m.reason?.trim()) fail('`mask[].reason` 은 필수다 — 사유 없는 면제는 게이트를 침묵시킨다');
    // 오타 하나가 조용히 영구 면제가 되는 것을 막는다. 검사할 수 없는 만료일은
    // 만료일이 아니라 주석이고, 이 필드가 막으려던 것이 정확히 그 상태다.
    if (m.until != null && parseUntil(m.until) == null) {
      fail(`\`mask[].until\` 은 YYYY-MM-DD 또는 ISO 8601 이어야 한다: ${m.until}`);
    }
  }

  // red-first: red 를 시연하지 못하는 룰은 `unproven` 으로 태어난다.
  // 등록을 막지는 않는다(정직한 상태로 두는 편이 낫다) — 집계에서 걸러진다.
  const provesRed = (def.prove ?? []).some((c) => c.expect === 'red');

  const criterionRev = sha(def.criterion.trim());
  const scanRev = sha(
    [
      fnRev(def.scan),
      def.detect == null
        ? 'none'
        : (Array.isArray(def.detect) ? def.detect : [def.detect])
            .map((r) => `${r.source}/${r.flags}`)
            .join('|'),
      stableStringify(def.match ?? null),
      stableStringify(def.params ?? {}),
      // subject 는 이제 함수다 — 데이터가 아니라 소스로 지문을 뜬다(`scan` 과 같은 방식).
      fnRev(def.subject),
      // skip 이 바뀌면 "이번엔 안 돈다" 의 범위가 바뀐다 — 과거 판정은 stale 이다.
      fnRev(def.skip),
    ].join('\n'),
  );

  return {
    ...def,
    id,
    criterionRev,
    scanRev,
    maskRev: maskRev(def.mask),
    lane: def.judge ? 'hybrid' : 'deterministic',
    prove: def.prove ?? [],
    params: def.params ?? {},
    severity: def.severity ?? 'high',
    ...(provesRed ? {} : { tags: [...(def.tags ?? []), 'unproven'] }),
  };
}

export function isRuleSpec(v: unknown): v is RuleSpec {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as RuleSpec).id === 'string' &&
    typeof (v as RuleSpec).criterionRev === 'string'
  );
}
