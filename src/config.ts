import type { Severity, Subject, Slice } from './types.ts';
import type { Lang } from './strings.ts';

export interface ExternalProvider {
  /** 파일이 아닌 대상을 슬라이스로 물질화한다. */
  resolve(params: Record<string, unknown>): Promise<Pick<Slice, 'files' | 'data' | 'meta'>>;
}

export interface JudgeOptions {
  /**
   * 판정을 누가 하는가. 기본 `subagent`.
   *
   * `inline` 은 산출자가 자기 산출을 판정하는 것이라 같은 맹점이 검증을 통과한다
   * (직무 분리 / 독립 검증 위배). 기본이 될 수 없지만, 세션이 그 코드를 건드리지
   * 않았을 때는 합리적이라 탈출구로 남긴다 — 켜면 매 실행 출력에 경고가 찍힌다.
   */
  delegate?: 'subagent' | 'inline';
  /**
   * 대상 프로젝트의 CLAUDE.md·규칙 문서를 판정자에게 주입할지. 기본 false.
   *
   * **켜면 staleness 에 구멍이 난다**: 그 문서는 `subjectHash` 에 안 잡히므로,
   * 문서가 바뀌어 판정이 뒤집혀야 할 때도 캐시가 fresh 라 재판정되지 않는다.
   * 규칙이 정말 판정 기준의 일부라면 이걸 켜지 말고 `subject` 로 슬라이스에
   * 넣어라 — 그러면 해시에 들어가 자동으로 무효화된다.
   */
  projectContext?: boolean;
  /** 판정자 1회 호출의 벽시계 상한(초). 초과는 통과가 아니라 `broken` 이다. */
  deadlineSeconds?: number;
  /** 판정자 슬라이스 1건의 문자 상한. 넘치면 잘라낸다. */
  sliceChars?: number;
}

export interface OutputOptions {
  /**
   * `instruct` = LLM 이 읽는 지시문, `json` = 기계 소비자, `pretty` = `instruct` 에
   * 색을 강제한 것(`color: 'always'` 와 같다). 기본 `instruct`.
   */
  format?: 'instruct' | 'json' | 'pretty';
  /** 프레임 문구의 언어. `criterion` 은 게이트 저자가 쓴 언어 그대로 나온다. */
  lang?: Lang;
  /** 통과한 게이트도 나열한다. 기본 false. */
  verbose?: boolean;
  /**
   * ANSI 색. 기본 `auto` — stdout 이 TTY 이고 `NO_COLOR` 가 없을 때만 칠한다.
   * 우선순위는 `--color` 플래그 > 이 값 > `NO_COLOR` > TTY 다. JSON 출력은 이 값과
   * 무관하게 색을 담지 않는다 — 파서가 읽는 표면에 제어 문자를 섞지 않는다.
   */
  color?: ColorMode;
}

export type ColorMode = 'auto' | 'always' | 'never';

/**
 * 실행 단위 커버리지 정책. 룰 하나하나의 상태가 정직해도, "몇 개를 돌리기로 했고
 * 그중 몇 개가 증거를 냈는가" 를 집계가 모르면 아무것도 안 돌린 실행이 exit 0 이
 * 된다. 두 스위치 모두 기본은 닫힘(fail-closed)이고, 여는 쪽은 매 실행 경고가 찍힌다.
 */
export interface CoverageOptions {
  /**
   * 고른 룰이 0 개여도 통과로 친다. 기본 false — 빈 선택은 `blocked` 다.
   * 아직 게이트가 없는 스위트를 의도적으로 비워 둘 때만 켠다.
   */
  allowEmpty?: boolean;
  /**
   * `unproven`(red 를 시연한 적 없는 룰)이 있으면 통과를 막는다. 기본 true.
   * 끄면 결함 0 건이 증거 없이 통과로 접힌다 — 픽스처를 아직 못 붙인 게이트를 잠시
   * 안고 갈 때의 탈출구이지 상시 설정이 아니다.
   */
  requireProven?: boolean;
}

/**
 * 이번 실행에서 무엇을 돌리는가. `include`/`exclude` 는 **분류 태그의 글롭**이고,
 * 룰 id 를 그대로 적어도 매칭된다(한 건만 넣고 빼는 탈출구).
 *
 * 소속(태그)은 게이트가 자기 자신에 대해 선언하고, 선택(스위트)은 레포가 선언한다.
 * 둘을 한 곳에 합치면 — 중앙 카테고리 레지스트리를 두면 — 게이트를 하나 추가할
 * 때마다 두 곳을 고쳐야 하고(single source of truth 위배), 외부 패키지에서
 * `extends` 로 들어온 게이트는 자기 소속을 들고 올 방법이 없어진다.
 */
export interface SuiteDef {
  include?: string[];
  exclude?: string[];
  /** 다른 스위트를 흡수한다. 글롭을 되풀이하지 않기 위한 것. */
  extends?: string[];
  /**
   * 이 스위트를 돌릴 때 반드시 선택돼 있어야 하는 룰 id. 태그 글롭이 어떤 이유로든
   * 그 룰을 놓치면 실행 자체가 거부된다 — 스위트가 조용히 줄어드는 것을 막는다.
   * `--rule` 로 한 건만 고른 실행에는 적용하지 않는다(의도된 부분 실행).
   */
  required?: string[];
  /** 이 스위트에서만 다르게 가져갈 실행 규칙. 보안은 medium 부터 막는 식. */
  failAt?: Severity;
  judge?: JudgeOptions;
  output?: OutputOptions;
  coverage?: CoverageOptions;
}

export interface GateConfig {
  /** 상속할 설정 묶음(패키지명 또는 경로). 뒤에 오는 것이 이긴다. */
  extends?: string[];
  /**
   * 룰 파일 위치. 기본 `gates/**\/*.rule.{mjs,js,ts}`.
   *
   * 글롭(`*` `?` `{` `[` 포함)은 **질의**다 — 아무것도 안 걸려도 오류가 아니다.
   * 글롭이 아닌 리터럴 경로는 **선언**이다 — 파일이 없거나 룰을 export 하지 않으면
   * 등록이 거부된다. 적어 둔 파일이 사라졌는데 나머지가 통과해서 exit 0 이 나오는 것이
   * 이 구분이 막는 실패다. 있어도 없어도 되는 파일은 글롭으로 적는다.
   */
  rules?: string[];
  /**
   * 등록돼 있어야 하는 룰 id. 파일 존재만으로는 부족하다 — 파일이 살아 있어도 다른
   * id 의 룰로 바뀌거나 export 가 빠질 수 있다. id 로 못 박으면 개수·경로가 아니라
   * 정체성으로 검사한다.
   */
  required?: string[];
  /** 룰이 subject 를 지정하지 않았을 때의 기본 대상. */
  subject?: Subject;
  /** 판정 저장소 위치. 기본 `.gate`. */
  store?: string;
  /**
   * 레포가 소유하는 면제 파일. 기본 `gate.masks.json`.
   * 캐시(`store`)와 분리된 이유는 `masks.ts` 머리말에 있다 — 면제는 캐시가 아니라
   * 커밋되고 리뷰되는 결정이다.
   */
  masks?: string;
  /** 이 심각도 이상이면 outcome 이 fail 이 된다. 기본 `high`. */
  failAt?: Severity;
  judge?: JudgeOptions;
  output?: OutputOptions;
  coverage?: CoverageOptions;
  /** 이름 붙인 실행 단위. `gate run <name>` 으로 고른다. */
  suites?: Record<string, SuiteDef>;
  /** 이름 없이 `gate run` 했을 때 고를 스위트. 없으면 전부 돌린다. */
  defaultSuite?: string;
  providers?: Record<string, ExternalProvider>;
  /** 판정 레인을 실행할 호스트. 미지정이면 파일 계약 호스트를 쓴다. */
  host?: string;
}

const DEFAULTS = {
  rules: ['gates/**/*.rule.mjs', 'gates/**/*.rule.js', 'gates/**/*.rule.ts'],
  store: '.gate',
  masks: 'gate.masks.json',
  failAt: 'high',
  judge: {
    delegate: 'subagent',
    projectContext: false,
    deadlineSeconds: 600,
    sliceChars: 65536,
  },
  output: {
    format: 'instruct',
    lang: 'ko',
    verbose: false,
    color: 'auto',
  },
  coverage: {
    allowEmpty: false,
    requireProven: true,
  },
} as const;

/** 기본값이 다 채워진 설정. 러너 내부는 이것만 본다 — `?.` 사슬이 사라진다. */
export type ResolvedConfig = GateConfig &
  Required<Pick<GateConfig, 'rules' | 'store' | 'masks' | 'failAt'>> & {
    judge: Required<JudgeOptions>;
    output: Required<OutputOptions>;
    coverage: Required<CoverageOptions>;
  };

export const DEFAULT_CONFIG: ResolvedConfig = DEFAULTS as unknown as ResolvedConfig;

export function defineConfig(c: GateConfig): GateConfig {
  return c;
}

/**
 * 설정 병합. 그룹(`judge`/`output`/`coverage`/`providers`)은 얕게 합치고 나머지는
 * 뒤가 이긴다. 그룹을 통째로 덮어쓰면 한 필드만 바꾸려던 소비자가 나머지 기본값을 잃는다.
 * `required` 는 합집합이다 — 스위트가 `extends` 로 부모를 흡수할 때 부모의 필수 선언이
 * 사라지면 그 스위트는 부모보다 약한 보증을 같은 이름으로 내게 된다.
 */
export function mergeConfig(base: GateConfig, over: GateConfig): GateConfig {
  const required = [...new Set([...(base.required ?? []), ...(over.required ?? [])])];
  return {
    ...base,
    ...over,
    rules: over.rules ?? base.rules,
    ...(required.length ? { required } : {}),
    judge: { ...base.judge, ...over.judge },
    output: { ...base.output, ...over.output },
    coverage: { ...base.coverage, ...over.coverage },
    suites: { ...base.suites, ...over.suites },
    providers: { ...base.providers, ...over.providers },
  };
}

/** 사용자 설정 위에 기본값을 깔아 러너가 쓸 형태로 만든다. */
export function resolveConfig(over: GateConfig = {}): ResolvedConfig {
  return mergeConfig(DEFAULT_CONFIG, over) as ResolvedConfig;
}
