/**
 * 게이트 커널의 어휘. 이 파일이 저작 표면의 계약이다.
 *
 * 설계 축 하나만 기억하면 된다: **탐색은 결정적으로, 판정만 비결정적으로.**
 * `scan` 은 후보를 만들고 `judge` 는 그 후보 안에서만 판정한다. 이 폐쇄성이
 * 재게이트 루프의 고정점을 만든다 — LLM 이 탐색까지 하면 매 라운드 새 지적이
 * 나와 수렴하지 않는다(선행 하네스 실측 7라운드).
 */

// 타입 전용 순환 참조다(config.ts 도 이 파일을 본다). 컴파일에서 지워지므로
// 런타임 순환은 생기지 않는다.
import type { GateConfig } from './config.ts';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.freeze({
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
});

/**
 * 위치. `line` 은 nullable 이되 **0 은 금지**다 — 0 을 허용하면 "파일 전체" 를
 * 가리키는 위치가 생기고, 면제·마스킹 한 줄이 그 파일의 결함을 통째로 강등하는
 * 우회 키가 된다(선행 게이트 러너 실측).
 */
export interface Location {
  file: string;
  line?: number | null;
  /** 1-based. 컬럼 정밀 마스킹을 위해 필요하다 — 줄 단위 마스킹은 불충분함이 실증됐다. */
  column?: number | null;
  endColumn?: number | null;
  quote?: string;
}

export interface Finding {
  /** 이 결함을 낸 룰 id. 커널이 채운다. */
  rule: string;
  /** `<rule>.<kebab-case>` — 결함 종류의 안정 식별자. 억제·통계의 키. */
  code: string;
  severity: Severity;
  message: string;
  /** 최소 1개. 위치 없는 결함은 확인 불가능하므로 등록 시 거부한다. */
  locations: Location[];
  /** 결정적 스캔이 낸 것인지, 판정자가 낸 것인지. 산출 책임 추적. */
  foundBy: 'scan' | 'judge';
  /**
   * 이 결함을 어떻게 고치는가. 지시문 출력의 `방법` 줄이 된다.
   * 없으면 룰의 `fix` 로 떨어진다. 둘 다 없으면 그 줄을 안 낸다 —
   * 지어낸 조치는 틀린 조치보다 나쁘다.
   */
  fix?: string;
  payload?: Record<string, unknown>;
}

/** 판정자에게 넘길 후보. `scan` 이 결정적으로 좁혀놓은 것만 여기 담긴다. */
export interface Candidate {
  /** 후보 종류 — 판정 계약이 종류별로 다른 질문을 할 수 있게 한다. */
  kind: string;
  /** 결함이 될 경우 부여될 code 의 접미부. */
  code: string;
  /** 판정자가 읽을 사실 진술. 결론을 담지 않는다. */
  message: string;
  locations: Location[];
  payload?: Record<string, unknown>;
}

export interface ScanResult {
  /** 이미 결정된 결함. 판정자를 거치지 않는다. */
  findings: Finding[];
  /** 판정이 갈리는 것만. 판정자는 이 배열 밖으로 나갈 수 없다. */
  candidates: Candidate[];
}

// ---------------------------------------------------------------------------
// Subject — 무엇을 대상으로 볼 것인가
// ---------------------------------------------------------------------------

/** 트리 참조. git ref 이거나 파일시스템 경로다. */
export interface TreeRef {
  /** git ref (`HEAD`, `origin/main`, 커밋 sha) — 지정하면 그 리비전의 트리를 읽는다. */
  ref?: string;
  /** 루트 경로. 다른 레포를 가리킬 수 있다(cross-repo 게이트). */
  root?: string;
}

/**
 * 대상을 해소할 때 주어지는 환경.
 * 커널이 아는 것만 넘긴다 — 나머지는 subject 함수가 알아서 한다.
 */
export interface SubjectEnv {
  cwd: string;
  config: GateConfig;
  /** 메타 게이트("모든 산출물에 검증자가 있는가")를 위한 룰 레지스트리. */
  registry: RuleSpec[];
  /** 룰의 `match` 로 좁혀진 경로 글롭. 커널이 사후 필터링도 하지만, 미리 알면 덜 읽는다. */
  narrow?: string[];
}

/**
 * subject 함수가 돌려주는 슬라이스 몸통. **해시는 커널이 붙인다** —
 * 그래서 대상을 아무리 새로 만들어도 캐시·staleness 계약은 깨지지 않는다.
 */
export interface SliceBody {
  files?: SliceFile[];
  /** 파일이 아닌 대상의 데이터. */
  data?: unknown;
  meta?: Record<string, unknown>;
  /** 리포트에 찍히는 라벨. 식별자가 아니라 표시용이다. */
  label?: string;
}

/**
 * **대상은 함수다.**
 *
 * 테스트 프레임워크가 "무엇을 테스트할 수 있는가" 를 열거하지 않는 것과 같다 —
 * `test(name, fn)` 의 `fn` 이 코드를 보고 정하듯, 게이트를 만들 때 `subject` 가
 * 무엇을 볼지 정한다. 커널이 종류를 열거하면 소비자마다 커널을 고쳐야 하고,
 * 그건 프레임워크가 아니라 그 코퍼스에 맞춘 도구다(실증: 게이트 하나 때문에
 * 커널에 7번째 종류를 추가해야 했다).
 *
 * `judge` 와 달리 클로저여도 된다. 판정자는 다른 컨텍스트로 건너가서 직렬화가
 * 필요하지만, 대상 해소는 러너 프로세스 안에서 끝난다.
 *
 * `subject.tree` / `diff` / `pair` … 는 이 함수를 돌려주는 **표준 라이브러리**이지
 * 커널의 특권 목록이 아니다.
 */
export type Subject = (env: SubjectEnv) => SliceBody | Promise<SliceBody>;

/** @deprecated `Subject` 를 쓴다. 이름이 데이터를 암시해 오해를 부른다. */
export type SubjectSpec = Subject;

export interface SliceFile {
  path: string;
  text: string;
  /** 줄 단위로 좁혔을 때 대상이 되는 줄(1-based). 없으면 파일 전체가 대상이다. */
  addedLines?: number[];
  /** 대조 대상의 내용(고정 원본·상대 트리). 없으면 대조가 아니다. */
  counterpart?: string | null;
  /** 여러 축을 합쳤을 때 이 파일이 온 축의 이름. */
  source?: string;
}

/** 해소된 대상. 판정자에게는 이것을 **미리 물질화해서** 넘긴다. */
export interface Slice {
  /** 표시용 라벨. 분기하지 않는다 — 커널은 대상의 종류를 모른다. */
  kind: string;
  files: SliceFile[];
  /** 파일이 아닌 대상의 데이터(external / command / rules). */
  data: unknown;
  meta: Record<string, unknown>;
  /** 대상의 내용 해시. 캐시 키의 한 축이며 staleness 판정에 쓴다. */
  hash: string;
}

// ---------------------------------------------------------------------------
// Judge — 비결정 레인
// ---------------------------------------------------------------------------

export interface JudgeSpec {
  /**
   * **필수.** 왜 결정적으로 판정할 수 없는가.
   * 결정성이 있는데 판정자를 쓰는 것은 고정점을 버리는 행위라, 이 문장이 없으면
   * 등록을 거부한다. "귀찮아서" 가 아니라 "문맥을 읽어야만 갈린다" 여야 한다.
   */
  because: string;
  /** 판정자에게 던지는 한 줄 질문. 대부분 이걸로 충분하다. */
  ask: string;
  /** 한 줄로 안 되는 축의 탈출구. 레포 상대 경로의 마크다운 계약. */
  contract?: string;
  /** 이 축이 낼 수 있는 최대 심각도. 축 단위 과잉 심각도를 눌러 앉힌다. */
  cap?: Severity;
  /**
   * red→green 전이에 확인 표를 요구한다(기본 true).
   * 비대칭 확인: red 는 1표로 나고, green 으로 넘어갈 때만 2표를 받는다.
   * 단측 오류(one-sided error)를 택해 비용을 게이트 수명당 +1 로 묶는다.
   */
  confirm?: boolean;
}

// ---------------------------------------------------------------------------
// Prove — red-first 등록 게이트
// ---------------------------------------------------------------------------

/**
 * 룰이 실제로 red 를 낼 수 있음을 보이는 픽스처.
 * 등록 시 `expect: 'red'` 케이스가 최소 1개 없으면 거부한다 — 한 번도 실패를
 * 보여준 적 없는 게이트는 통과를 증명하지 못한다(`broken` 상태의 기계적 방지).
 */
export interface ProveCase {
  name: string;
  /**
   * 가상 슬라이스. path → 내용.
   * 문자열 대신 객체를 주면 `counterpart`(pair 대조본)·`addedLines`(변경분 한정)·
   * `source`(합성 대상의 축)까지 오프라인으로 재현할 수 있다 — 그래야 두 트리 대조나
   * 합성 대상 게이트도 라이브 환경 없이 픽스처로 증명된다.
   */
  files: Record<
    string,
    | string
    | { text: string; counterpart?: string | null; addedLines?: number[]; source?: string }
  >;
  /** 파일이 아닌 대상(`external` / `command` / `rules`)의 가상 데이터. */
  data?: unknown;
  expect: 'red' | 'green';
  /** 이 케이스에서만 덮어쓸 파라미터. */
  params?: Record<string, unknown>;
  /** red 를 기대할 때, 특정 code 가 나와야 한다면 지정한다. */
  code?: string;
}

// ---------------------------------------------------------------------------
// Rule
// ---------------------------------------------------------------------------

export interface ScanContext {
  slice: Slice;
  params: Record<string, unknown>;
  /** 슬라이스 안의 파일만 읽는다. 밖을 읽으면 던진다 — 폐쇄성은 도구 접근으로 강제된다. */
  read(path: string): string;
  files(): SliceFile[];
  /** `<rule>.<kebab>` code 를 붙여 결함을 만든다. */
  finding(code: string, message: string, locations: Location[], extra?: Partial<Finding>): Finding;
  candidate(
    kind: string,
    code: string,
    message: string,
    locations: Location[],
    payload?: Record<string, unknown>,
  ): Candidate;
}

export interface RuleDef {
  /**
   * 사람이 읽는 기준 문장. 일급 필드다 — 이 문장이 바뀌면 과거 판정은 `stale` 이 된다.
   * 게이트가 무엇을 보장하는지가 코드가 아니라 여기 적힌다.
   */
  criterion: string;
  subject?: SubjectSpec;
  /** 결정적 좁히기. subject 위에 얹는 글롭. */
  match?: string | string[];
  /** 선언형 탐지 sugar. 매치되면 곧장 결함이 된다. */
  detect?: RegExp | RegExp[];
  /** 명령형 탐색. 결함과 후보를 함께 낸다. */
  scan?: (ctx: ScanContext) => ScanResult | Promise<ScanResult>;
  /**
   * 이 룰의 위반을 어떻게 고치는가 — 결함별 `fix` 가 없을 때의 기본 문구.
   * `criterion` 이 "무엇을 보장하나", `message` 가 "무엇이 틀렸나" 라면
   * 이건 "무엇을 해라" 다. 셋이 다 있어야 출력이 지시문이 된다.
   */
  fix?: string;
  /** 비결정 레인. 있으면 hybrid, 없으면 결정적. */
  judge?: JudgeSpec;
  severity?: Severity;
  /** 이 룰이 낼 수 있는 최대 심각도. `'info'` 로 두면 어드바이저리 게이트가 된다. */
  severityCap?: Severity;
  /**
   * 이번 실행에서 이 게이트가 적용 대상이 아닌가. **사유 문자열**을 돌려주면
   * 건너뛰고, `false` 를 돌려주면 돈다.
   *
   * 사유를 강제하는 이유: 조용한 건너뛰기는 조용한 초록과 같은 병이다 — 안 돈
   * 게이트가 통과한 게이트와 구별되지 않으면 커버리지 숫자가 거짓말이 된다.
   *
   * 커널이 빈 슬라이스를 보고 스스로 추론하지 않는 이유도 같다. "이번 변경에
   * .sql 이 없다" 와 "대상 파일이 전부 지워졌다" 를 커널은 구별할 수 없고,
   * 구별하려면 커널이 도메인을 알아야 한다 — `subject` 를 열거하지 않는 것과
   * 같은 이유로 그건 커널의 몫이 아니다. 게이트가 선언하고 커널이 강제한다.
   */
  skip?: (
    slice: Slice,
    params: Record<string, unknown>,
  ) => string | false | Promise<string | false>;
  params?: Record<string, unknown>;
  prove?: ProveCase[];
  /** 오탐 억제. 컬럼 정밀 스팬을 받는다. */
  mask?: MaskSpec[];
  tags?: string[];
  /** 이 룰이 강제하는 산출물 키 — 메타 게이트(검증자 커버리지)의 입력. */
  validates?: string[];
}

export interface MaskSpec {
  file: string;
  line?: number;
  column?: number;
  endColumn?: number;
  code?: string;
  /** 왜 면제인가. 사유 없는 마스크는 등록을 거부한다. */
  reason: string;
  /**
   * 만료일(`YYYY-MM-DD` 또는 ISO 8601). 이 날짜가 지나면 마스크는 **효력을 잃고**
   * 결함이 다시 올라온다.
   *
   * 자유 문자열이 아니라 날짜인 이유: 기계가 검사할 수 없는 해제 조건("리팩터
   * 끝나면")은 해제 조건이 아니라 주석이고, 영구 면제와 구별되지 않는다.
   * 파싱되지 않는 값은 등록에서 거부한다 — 오타 하나가 조용히 영구 면제가 되는
   * 것이 이 필드가 막으려던 바로 그 실패다.
   *
   * 생략하면 만료가 없다. 게이트가 틀린 것(진짜 오탐)에 대한 정정은 부채가
   * 아니라서 기한을 붙일 이유가 없기 때문이다.
   */
  until?: string;
}

export interface RuleSpec extends RuleDef {
  id: string;
  /** criterion 의 해시. staleness 의 한 축. */
  criterionRev: string;
  /** scan/detect/skip 소스의 해시. 탐색 로직이 바뀌면 과거 판정은 stale 이다. */
  scanRev: string;
  /** 마스크 집합의 해시. 면제를 더하거나 지우면 과거 판정은 stale 이다. */
  maskRev: string;
  lane: 'deterministic' | 'hybrid';
  /** 룰 파일 경로. 등록기가 채운다. */
  source?: string;
}

// ---------------------------------------------------------------------------
// Verdict / lifecycle
// ---------------------------------------------------------------------------

/**
 * - `unproven` : 아직 red 를 시연한 적 없다.
 * - `red`      : 결함 있음.
 * - `green`    : 결함 없음 + 과거에 red 를 낸 적 있다.
 * - `stale`    : 판정은 있으나 기준·대상·탐색이 바뀌었다. **green 이 아니다.**
 * - `skipped`  : 이번 실행의 적용 대상이 아니다. **green 이 아니다** — 안 돈
 *                게이트를 통과로 세면 커버리지 숫자가 거짓말을 시작한다.
 * - `broken`   : 판정 불가(타임아웃·계약 위반). 집계에서 제외한다.
 */
export type GateState = 'unproven' | 'red' | 'green' | 'stale' | 'skipped' | 'broken';

export interface Verdict {
  rule: string;
  state: GateState;
  findings: Finding[];
  /** 이 판정을 만든 캐시 키. */
  key: string;
  criterionRev: string;
  scanRev: string;
  maskRev: string;
  subjectHash: string;
  lane: 'deterministic' | 'hybrid';
  /** 판정자를 몇 번 불렀는가. 비대칭 확인의 비용 추적. */
  judgeCalls?: number;
  cacheHit?: boolean;
  wallMs?: number;
  /** `broken` 의 고장 사유 또는 `skipped` 의 제외 사유. */
  reason?: string;
  /** 이번 실행에서 만료돼 효력을 잃은 마스크. 결함이 왜 되돌아왔는지의 근거다. */
  expiredMasks?: MaskSpec[];
  at: string;
}

export interface RunOutcome {
  verdicts: Verdict[];
  /** 집계 결과. `broken` 은 제외되고 `stale` 은 통과가 아니다. */
  outcome: 'pass' | 'fail' | 'blocked';
  /** 심각도별 결함 수(집계 대상만). */
  counts: Record<Severity, number>;
  /** 판정하지 못한 룰 — fail-closed 의 근거. */
  unjudged: string[];
  startedAt: string;
  finishedAt: string;
}
