import type { RuleSpec } from './types.ts';
import { matchesTag } from './glob.ts';
import { mergeConfig, type GateConfig, type ResolvedConfig, type SuiteDef } from './config.ts';

/**
 * 게이트는 한 레벨에 나란히 있지 않다. "문서 정합성" 은 그 자체로 큰 축이면서 안에
 * 용어·링크·API 같은 축을 또 갖고, 코드·보안도 마찬가지다. 그래서 분류는 **트리가
 * 아니라 패싯(faceted classification, Ranganathan)** 으로 잡는다 — 한 게이트가 여러
 * 축에 동시에 속할 수 있어야 하기 때문이다(스펙↔시그니처 일치 게이트는 docs 이면서
 * code 다). 엄격한 트리는 그 게이트를 담을 자리가 없다.
 *
 * 커널은 어떤 카테고리가 존재하는지 **모른다**. `subject` 가 볼 수 있는 것을
 * 열거하지 않는 것과 같은 이유다 — 열거하는 순간 프레임워크가 도메인을 소유하고,
 * 목록에 없는 축을 쓰려는 소비자는 프레임워크를 우회하게 된다.
 */
export interface ResolvedSuite {
  name: string;
  include: string[];
  exclude: string[];
  /** 이 스위트가 선택돼 있기를 요구하는 룰 id. `extends` 를 따라 합집합이다. */
  required: string[];
  config: ResolvedConfig;
}

export const ALL_SUITE = 'all';

/** 스위트 정의를 `extends` 따라 펼친다. 순환은 무시하고 지나간다(정의는 집합 합집합이라 무해). */
function flatten(
  suites: Record<string, SuiteDef>,
  name: string,
  seen: Set<string>,
): { include: string[]; exclude: string[]; required: string[]; overrides: GateConfig } {
  if (seen.has(name)) return { include: [], exclude: [], required: [], overrides: {} };
  seen.add(name);
  const def = suites[name];
  if (!def) throw new Error(`알 수 없는 스위트: ${name} — gate.config 의 suites 에 없다.`);

  const include = [...(def.include ?? [])];
  const exclude = [...(def.exclude ?? [])];
  // 스위트의 `required` 는 선택에 대한 요구라, 레지스트리에 대한 요구인
  // `config.required` 와 섞이지 않게 overrides 밖에서 따로 모은다.
  const required = [...(def.required ?? [])];
  let overrides: GateConfig = {};

  for (const parent of def.extends ?? []) {
    const p = flatten(suites, parent, seen);
    include.push(...p.include);
    exclude.push(...p.exclude);
    required.push(...p.required);
    overrides = mergeConfig(overrides, p.overrides);
  }

  const own: GateConfig = {};
  if (def.failAt) own.failAt = def.failAt;
  if (def.judge) own.judge = def.judge;
  if (def.output) own.output = def.output;
  if (def.coverage) own.coverage = def.coverage;
  return { include, exclude, required: [...new Set(required)], overrides: mergeConfig(overrides, own) };
}

/**
 * 이번 실행의 스위트를 확정한다. 이름이 없으면 `defaultSuite`, 그것도 없으면 전부.
 * 스위트가 얹는 실행 규칙(`failAt` 등)은 레포 설정 위에 덮인다 — 그래서 보안 스위트만
 * medium 부터 막는 식이 가능하다.
 */
export function resolveSuite(config: ResolvedConfig, name?: string): ResolvedSuite {
  const picked = name ?? config.defaultSuite;
  if (!picked) return { name: ALL_SUITE, include: ['**'], exclude: [], required: [], config };

  const { include, exclude, required, overrides } = flatten(config.suites ?? {}, picked, new Set());
  return {
    name: picked,
    include: include.length ? include : ['**'],
    exclude,
    required,
    config: mergeConfig(config, overrides) as ResolvedConfig,
  };
}

export interface Selection {
  targets: RuleSpec[];
  /** 태그가 없어 분류되지 않은 게이트. 스위트와 무관하게 항상 돌지만 매 실행 경고한다. */
  unclassified: RuleSpec[];
  /**
   * 스위트가 `required` 로 요구했는데 선택에 없는 룰 id. 비어 있지 않으면 이 선택으로
   * 실행해서는 안 된다 — 러너와 CLI 가 실행 전에 거부한다. `only` 로 좁힌 선택에는
   * 적용하지 않는다(`--rule` 은 의도된 부분 실행이다).
   */
  missing: string[];
}

/**
 * 스위트로 게이트를 고른다.
 *
 * **태그 없는 게이트는 어떤 스위트를 돌리든 항상 포함된다.** 분류를 안 했다고 조용히
 * 빠지면 그 게이트는 커버리지에서 사라진 채 통과처럼 보인다 — 게이트 프레임워크에서
 * 가장 나쁜 실패 방식이다(fail-open). 대신 매 실행 경고해서 분류를 유도한다.
 */
export function selectRules(rules: RuleSpec[], suite: ResolvedSuite, only?: string[]): Selection {
  const targets: RuleSpec[] = [];
  const unclassified: RuleSpec[] = [];

  for (const r of rules) {
    if (only?.length && !only.includes(r.id)) continue;

    const tags = (r.tags ?? []).filter((t) => t !== 'unproven');
    if (!tags.length) {
      unclassified.push(r);
      targets.push(r);
      continue;
    }
    if (suite.exclude.length && tags.some((t) => matchesTag(t, suite.exclude))) continue;
    // 룰 id 직접 지정은 태그를 우회하는 탈출구다 — 한 건만 넣고 빼는 데 쓴다.
    if (tags.some((t) => matchesTag(t, suite.include)) || matchesTag(r.id, suite.include)) {
      targets.push(r);
    }
  }
  const picked = new Set(targets.map((r) => r.id));
  const missing = only?.length ? [] : suite.required.filter((id) => !picked.has(id));
  return { targets, unclassified, missing };
}

/**
 * 태그의 최상위 마디. 출력에서 축별로 묶는 데 쓴다.
 * 여러 축에 속한 게이트는 **첫 태그가 1차 축**이다 — 게이트 저자가 적은 순서를
 * 그대로 존중한다. 커널이 어느 축이 더 중요한지 정할 근거가 없다.
 */
export function axisOf(rule: RuleSpec): string | undefined {
  const tag = (rule.tags ?? []).find((t) => t !== 'unproven');
  return tag?.split('/')[0];
}
