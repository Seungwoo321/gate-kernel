import { join, relative } from 'node:path';
import type { Finding, MaskSpec, RuleSpec, Severity, Verdict } from './types.ts';
import { SEVERITY_RANK } from './types.ts';
import type { RunResult } from './run.ts';
import type { JudgeRequest } from './lanes/judge.ts';
import { JUDGE_DIR } from './lanes/judge.ts';
import { strings, type Lang, type Tally } from './strings.ts';
import { axisOf } from './suite.ts';

/**
 * 실행 결과를 **읽는 LLM 에게 하는 지시문**으로 렌더링한다.
 *
 * 리포트가 아니라 지시문인 이유: 소비자가 사람 대시보드가 아니라 LLM 이다.
 * 상태 목록(`✗ rule-id [high] file:line`)을 받은 LLM 은 행동하는 대신 사용자에게
 * 요약해 보고하고 턴을 끝낸다. 그래서 모든 항목이 동사로 시작하고, 맨 위에 할 일
 * 목록이 오고, 끝의 정의(`outcome: pass`)가 명시된다.
 *
 * 기계 소비자(CI·스크립트)는 `--json` 을 쓴다. 두 표면은 같은 `RunResult` 에서 나온다.
 */

/** 한 줄로 요약되는 행동 단위. 번호는 렌더 순서에서 붙는다. */
type Action =
  | { kind: 'fix'; rule: RuleSpec; verdict: Verdict }
  | { kind: 'ask'; rule: RuleSpec; req: JudgeRequest }
  | { kind: 'repair'; rule: RuleSpec; verdict: Verdict };

export interface RenderOptions {
  cwd: string;
  storeDir: string;
  lang?: Lang;
  /** 통과한 게이트도 나열한다. 기본 false — 할 일만 보이는 편이 행동을 부른다. */
  verbose?: boolean;
  /** 판정에 프로젝트 문서를 주입하고 있는가. 켜져 있으면 매 실행 경고한다. */
  projectContext?: boolean;
  /** 판정을 위임하지 않고 세션이 직접 하는가. */
  inlineJudge?: boolean;
  /** 재실행 명령. 훅이 다른 명령으로 부를 수 있어 주입받는다. */
  rerunCmd?: string;
  /** 이번에 돌린 스위트. 전부 돌렸으면 생략한다. */
  suite?: string;
  /** 태그가 없어 분류되지 않은 게이트 id. 있으면 경고한다. */
  unclassified?: string[];
  /** 이 심각도부터 통과를 막는다. 이 아래 결함은 할 일이 아니라 참고다. */
  failAt?: Severity;
}

const MARK = { pass: '✓', fail: '✗', blocked: '✗' } as const;
const FINDINGS_SHOWN = 10;
const CANDIDATES_SHOWN = 6;

/** 면제 한 건을 사람이 알아볼 한 줄로. */
function maskLine(m: MaskSpec): string {
  return `${m.file}${m.line != null ? `:${m.line}` : ''}${m.code ? ` (${m.code})` : ''} — ${m.reason}${m.until ? ` [${m.until}]` : ''}`;
}

function loc(f: Finding): string {
  const l = f.locations[0];
  if (!l) return '';
  return `${l.file}${l.line ? `:${l.line}` : ''}`;
}

/**
 * 판정 요청 파일의 표시 경로. 판정자에게 넘길 근거는 이 파일 안에 이미 다
 * 물질화돼 있다 — 판정자가 레포를 뒤지지 않게 하는 것이 슬라이스 폐쇄의 본체다.
 */
function requestPath(o: RenderOptions, req: JudgeRequest): string {
  const abs = join(o.storeDir, JUDGE_DIR, req.key.slice(0, 8), `${req.rule}.r${req.round}.request.json`);
  const rel = relative(o.cwd, abs);
  return rel.startsWith('..') ? abs : rel;
}

export function renderRun(result: RunResult, rules: RuleSpec[], o: RenderOptions): string {
  const s = strings(o.lang);
  const byId = new Map(rules.map((r) => [r.id, r]));
  const rerunCmd = o.rerunCmd ?? 'gate run';

  const actions: Action[] = [];
  const unproven: Verdict[] = [];
  const advisory: { rule: RuleSpec; findings: Finding[] }[] = [];
  const skipped: Verdict[] = [];
  // 만료 면제는 두 곳에서 온다: 이번 실행의 탐색(`result.expired`)과, 캐시에서
  // 재생된 과거 판정(`v.expiredMasks`). 둘 다 봐야 판정이 캐시로 돌아온 라운드에서도
  // "왜 되돌아왔는지" 가 남는다. 같은 룰이면 이번 실행 쪽이 최신이다.
  const expiredByRule = new Map<string, MaskSpec[]>();
  const failAt = o.failAt ?? 'high';

  // 순서가 곧 우선순위다. 결정적 위반이 먼저 — 값이 싸고 이견이 없다.
  //
  // 차단 등급 아래의 결함은 할 일 목록에 넣지 않는다. `고쳐라` 는 명령문이고,
  // 통과를 막지도 않는 것에 명령문을 쓰면 다음번엔 진짜 차단 항목의 명령문도
  // 같은 무게로 읽힌다 — 어드바이저리 게이트(`severityCap: 'info'`)를 두는 이유
  // 자체가 사라진다.
  for (const v of result.verdicts) {
    if (v.state !== 'red' || !v.findings.length) continue;
    const rule = byId.get(v.rule);
    if (!rule) continue;
    const blocking = v.findings.filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failAt]);
    const below = v.findings.filter((f) => SEVERITY_RANK[f.severity] < SEVERITY_RANK[failAt]);
    if (blocking.length) actions.push({ kind: 'fix', rule, verdict: { ...v, findings: blocking } });
    if (below.length) advisory.push({ rule, findings: below });
  }
  for (const req of result.pending) {
    const rule = byId.get(req.rule);
    if (rule) actions.push({ kind: 'ask', rule, req });
  }
  for (const v of result.verdicts) {
    if (v.state === 'broken') {
      const rule = byId.get(v.rule);
      if (rule) actions.push({ kind: 'repair', rule, verdict: v });
    }
    if (v.state === 'unproven') unproven.push(v);
    if (v.state === 'skipped') skipped.push(v);
    if (v.expiredMasks?.length) expiredByRule.set(v.rule, v.expiredMasks);
  }
  for (const e of result.expired) expiredByRule.set(e.rule, e.masks);
  const expired = [...expiredByRule].map(([rule, masks]) => ({ rule, masks }));

  // 축이 둘 이상이면 축이 1차 정렬 기준이 된다. 축 안에서는 fix → ask → repair
  // 순서가 그대로 유지된다(그룹핑이 안정 정렬이라).
  const ordered = [...groupByAxis(actions).values()].flat();
  actions.length = 0;
  actions.push(...ordered);

  const seen = new Set<string>();
  for (const v of result.verdicts) seen.add(v.rule);
  for (const r of result.pending) seen.add(r.rule);

  const tally: Tally = {
    total: seen.size,
    passed: result.verdicts.filter((v) => v.state === 'green').length,
    fix: actions.filter((a) => a.kind === 'fix').length,
    ask: actions.filter((a) => a.kind === 'ask').length,
    repair: actions.filter((a) => a.kind === 'repair').length,
    skipped: skipped.length,
  };

  const lines: string[] = [];

  if (tally.total === 0) {
    lines.push(s.noRules('gate.config.mjs 와 gates/ 를 확인해라.'));
    return `${lines.join('\n')}\n`;
  }

  lines.push(s.header(result.outcome, MARK[result.outcome], tally));
  if (o.suite) lines.push(s.suiteLine(o.suite));
  lines.push('');

  if (o.unclassified?.length) lines.push(s.warnUnclassified(o.unclassified), '');
  if (o.inlineJudge) lines.push(s.warnInlineJudge(), '');
  if (o.projectContext) lines.push(s.warnProjectContext(), '');

  if (actions.length === 0) {
    lines.push(s.nothingToDo());
  } else {
    lines.push(rule80(s.todoHeading()));
    lines.push(...todoIndex(actions, s));
    lines.push(`[${actions.length + 1}] ${s.rerun(rerunCmd)}`);
    lines.push('━'.repeat(76), '');
    actions.forEach((a, i) => {
      lines.push(...detail(i + 1, a, s, o));
      lines.push('');
    });
  }

  // 안 돈 게이트는 통과 옆이 아니라 자기 제목 아래에 선다. 초록 사이에 섞이면
  // 커버리지 숫자가 조용히 거짓말을 시작한다.
  if (skipped.length) {
    lines.push('', `── ${s.skippedHeading()} ──`);
    for (const v of skipped) lines.push(s.skippedBlock(v.rule, v.reason ?? '?'), '');
  }

  if (advisory.length || expired.length || unproven.length) {
    lines.push('', `── ${s.advisoryHeading()} ──`);
    for (const a of advisory) {
      const items = a.findings
        .slice(0, FINDINGS_SHOWN)
        .map((f) => `[${f.severity}] ${loc(f)} — ${f.message}`);
      if (a.findings.length > FINDINGS_SHOWN) items.push(`… ${s.moreFindings(a.findings.length - FINDINGS_SHOWN)}`);
      lines.push(s.advisoryBlock(a.rule.id, a.rule.criterion, items), '');
    }
    for (const e of expired) lines.push(s.expiredMaskBlock(e.rule, e.masks.map(maskLine)), '');
    for (const v of unproven) {
      lines.push(s.unprovenBlock(v.rule, byId.get(v.rule)?.criterion ?? ''), '');
    }
  }

  if (o.verbose) {
    const green = result.verdicts.filter((v) => v.state === 'green');
    for (const v of green) lines.push(`✓ ${v.rule}${v.cacheHit ? ' (cached)' : ''}`);
    if (green.length) lines.push('');
  }

  lines.push(
    result.outcome === 'pass'
      ? s.footerPass()
      : result.outcome === 'fail'
        ? s.footerFail(tally.ask)
        : s.footerBlocked(),
  );
  return `${lines.join('\n')}\n`;
}

function rule80(title: string): string {
  const bar = '━'.repeat(Math.max(4, 74 - title.length * 2));
  return `━━ ${title} ${bar}`;
}

/**
 * 할 일 목록. 축이 둘 이상 걸쳐 있으면 축별로 묶는다 — 문서와 보안을 한 줄기로
 * 늘어놓으면 읽는 쪽이 서로 다른 종류의 일을 한 뭉치로 보고 하나만 처리한다.
 * 축이 하나뿐이면 소제목이 정보가 아니라 소음이라 붙이지 않는다.
 */
function groupByAxis(actions: Action[]): Map<string, Action[]> {
  const axes = new Map<string, Action[]>();
  for (const a of actions) {
    const key = axisOf(a.rule) ?? '';
    const bucket = axes.get(key);
    if (bucket) bucket.push(a);
    else axes.set(key, [a]);
  }
  return axes;
}

function todoIndex(actions: Action[], s: ReturnType<typeof strings>): string[] {
  const axes = groupByAxis(actions);
  let n = 0;
  if (axes.size < 2) return actions.map((a) => indexLine(++n, a, s));

  const lines: string[] = [];
  for (const [axis, group] of axes) {
    lines.push(axis ? s.axisHeading(axis) : s.unclassifiedAxis());
    for (const a of group) lines.push(`  ${indexLine(++n, a, s)}`);
  }
  return lines;
}

function indexLine(n: number, a: Action, s: ReturnType<typeof strings>): string {
  const idx = `[${n}]`;
  if (a.kind === 'fix') {
    const first = a.verdict.findings[0];
    const where = first ? loc(first) : '';
    const more = a.verdict.findings.length > 1 ? ` (+${a.verdict.findings.length - 1})` : '';
    return `${idx} ${s.verbFix()}   ${a.rule.id}   ${where}${more}`;
  }
  if (a.kind === 'ask') {
    return `${idx} ${s.verbAsk()}   ${a.rule.id}   ${s.askSelfJudgeWarning()}`;
  }
  return `${idx} ${s.verbRepair()}   ${a.rule.id}`;
}

function detail(
  n: number,
  a: Action,
  s: ReturnType<typeof strings>,
  o: RenderOptions,
): string[] {
  const head = `[${n}] ${a.kind === 'fix' ? s.verbFix() : a.kind === 'ask' ? s.verbAsk() : s.verbRepair()} — ${a.rule.id}`;
  const out = [head, `  ${s.labelCriterion()}   ${a.rule.criterion}`];

  if (a.kind === 'fix') {
    const shown = a.verdict.findings.slice(0, FINDINGS_SHOWN);
    for (const g of groupByFix(shown, a.rule.fix)) {
      for (const f of g.findings) out.push(`  ${s.labelViolation()}   ${loc(f)} — ${f.message}`);
      if (g.how) out.push(`  ${s.labelHow()}   ${indentWrap(g.how)}`);
    }
    if (a.verdict.findings.length > shown.length) {
      out.push(`  … ${s.moreFindings(a.verdict.findings.length - shown.length)}`);
    }
    return out;
  }

  if (a.kind === 'repair') {
    out.push(s.brokenBlock(a.verdict.reason ?? '?'));
    return out;
  }

  const req = a.req;
  out.push(`  ${s.labelCandidates()}   ${req.candidates.length}건`);
  // code 를 찍는 이유: 면제 명령의 인자가 이것이다. 게이트가 실제로 낸 code 만
  // 면제할 수 있으므로, 여기 없는 것은 면제할 수도 없다.
  for (const c of req.candidates.slice(0, CANDIDATES_SHOWN)) {
    const where = c.locations.map((l) => `${l.file}${l.line ? `:${l.line}` : ''}`).join(' · ');
    out.push(`    ${c.code}   ${where}`);
  }
  if (req.candidates.length > CANDIDATES_SHOWN) {
    out.push(`    … ${s.moreFindings(req.candidates.length - CANDIDATES_SHOWN)}`);
  }
  out.push('');
  out.push(
    s.judgeBlock({
      slicePath: requestPath(o, req),
      ask: req.ask,
      because: req.because,
      judgeCmd: `gate judge ${req.rule} --verdict <답을 적은 파일>`,
      maskCmd: `gate mask ${req.rule} ${req.candidates[0]?.code ?? '<code>'} --reason "<왜 위반이 아닌가>"`,
    }),
  );
  return out;
}

/**
 * 같은 조치를 가리키는 결함끼리 묶는다. 한 룰의 위반 20건에 같은 `방법` 을 20번
 * 되풀이하면 읽는 쪽이 그 줄을 장식으로 취급하기 시작한다.
 */
function groupByFix(
  findings: Finding[],
  ruleFix: string | undefined,
): { how: string | undefined; findings: Finding[] }[] {
  const groups: { how: string | undefined; findings: Finding[] }[] = [];
  for (const f of findings) {
    const how = f.fix ?? ruleFix;
    const last = groups[groups.length - 1];
    if (last && last.how === how) last.findings.push(f);
    else groups.push({ how, findings: [f] });
  }
  return groups;
}

/** 여러 줄 `fix` 문구를 라벨 열에 맞춰 들여쓴다. */
function indentWrap(text: string): string {
  return text.split('\n').join('\n         ');
}
