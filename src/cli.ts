#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadRules, RuleRegistryError } from './registry.ts';
import { run, storeDirOf } from './run.ts';
import { prove } from './prove.ts';
import { resolveColor } from './ansi.ts';
import type { ColorMode } from './config.ts';
import {
  allRequests,
  ingest,
  JudgeContractError,
  pendingRequests,
  responsePath,
  writeResponse,
  type JudgeRequest,
  type JudgeResponse,
} from './lanes/judge.ts';
import {
  loadMaskFile,
  maskFilePath,
  parseUntil,
  saveMaskFile,
  type MaskFile,
} from './masks.ts';
import { renderList, renderProve, renderRun, renderStatus, type StatusRow } from './report.ts';
import type { Lang } from './strings.ts';
import * as verdicts from './store/verdicts.ts';
import { resolveSuite, selectRules, ALL_SUITE } from './suite.ts';
import type { Location, MaskSpec, RuleSpec } from './types.ts';

/**
 * 종료 코드는 계약이다 — 오케스트레이터(플러그인)가 이걸 보고 다음 단계를 정한다.
 * `JUDGE_REQUIRED` 가 별도 코드인 이유: "아직 결론이 아님" 을 실패나 통과 어느
 * 쪽으로도 접지 않기 위해서다.
 */
const EXIT = { PASS: 0, FAIL: 1, USAGE: 2, BLOCKED: 3, JUDGE_REQUIRED: 20 } as const;

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name: string): boolean => argv.includes(`--${name}`);
const cwd = flag('cwd') ?? process.cwd();

const FORMATS = new Set(['json', 'instruct', 'pretty']);
const COLOR_MODES = new Set(['auto', 'always', 'never']);

/**
 * 출력 형식·색은 세 층에서 온다: 플래그 > 설정 > 기본. `--json` 은 `--format json` 의
 * 축약이다. `pretty` 는 `instruct` 에 색을 강제한 것이라 별도 렌더러가 아니다 —
 * 사람용 진실을 둘로 만들지 않는다. JSON 은 어떤 색 설정에서도 색을 담지 않는다.
 */
function outputMode(cfg: { format?: string; color?: ColorMode } | undefined): { json: boolean; color: boolean } {
  const fmtFlag = flag('format');
  if (fmtFlag != null && !FORMATS.has(fmtFlag)) throw new UsageError(`--format 은 json|instruct|pretty 중 하나다: ${fmtFlag}`);
  const colorFlag = flag('color');
  if (colorFlag != null && !COLOR_MODES.has(colorFlag)) throw new UsageError(`--color 는 auto|always|never 중 하나다: ${colorFlag}`);
  const format = has('json') ? 'json' : (fmtFlag ?? cfg?.format ?? 'instruct');
  const color = resolveColor({
    flag: (colorFlag as ColorMode | undefined) ?? (format === 'pretty' ? 'always' : undefined),
    config: cfg?.color,
    noColor: process.env['NO_COLOR'],
    isTTY: process.stdout.isTTY === true,
  });
  return { json: format === 'json', color: format !== 'json' && color };
}

class UsageError extends Error {}

function out(v: unknown): void {
  process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
}

/**
 * 판정자가 남긴 파일을 응답 계약으로 정규화한다.
 *
 * `rule`/`key`/`round` 를 요청에서 채우는 이유: 그건 판정자가 알 필요 없는 기계
 * 식별자인데, 베껴 적게 하면 잘못 베낀 답이 통째로 버려지는 실패가 판정 품질과
 * 무관하게 생긴다. 판정자가 책임지는 것은 `decisions` 하나뿐이다.
 */
function normalizeResponse(req: JudgeRequest, raw: unknown): JudgeResponse {
  const body = Array.isArray(raw) ? { decisions: raw } : (raw as Partial<JudgeResponse>);
  const decisions = body?.decisions;
  if (!Array.isArray(decisions)) {
    throw new JudgeContractError(
      '판정 파일은 `{ "decisions": [{ "code": …, "violates": true|false, "why": … }] }` 여야 한다',
    );
  }
  for (const d of decisions) {
    if (typeof d?.code !== 'string' || typeof d?.violates !== 'boolean') {
      throw new JudgeContractError(`decisions 항목에 code(string)/violates(boolean) 가 없다: ${JSON.stringify(d)}`);
    }
    if (!d.why?.trim()) {
      throw new JudgeContractError(`\`why\` 없는 판정은 받지 않는다: ${d.code}`);
    }
  }
  return { rule: req.rule, key: req.key, round: req.round, decisions };
}

/** 마스크 대상의 좌표를 게이트가 실제로 낸 것에서만 찾는다. */
function locateCode(
  storeDir: string,
  ruleId: string,
  code: string,
): { code: string; locations: Location[] } | undefined {
  const full = code.startsWith(`${ruleId}.`) ? code : `${ruleId}.${code}`;
  for (const req of allRequests(storeDir)) {
    if (req.rule !== ruleId) continue;
    const c = req.candidates.find((x) => x.code === full);
    if (c) return { code: full, locations: c.locations };
  }
  const v = verdicts.load(storeDir, ruleId);
  const f = v?.findings.find((x) => x.code === full);
  return f ? { code: full, locations: f.locations } : undefined;
}

async function main(): Promise<number> {
  if (cmd === 'help' || has('help')) {
    process.stdout.write(
      [
        'gate — LLM 게이트 러너',
        '',
        '  gate init                   gate.config.mjs + gates/ 를 만든다',
        '  gate list                   등록된 룰과 레인을 보여준다',
        '  gate prove [--rule <id>]    red-first 픽스처를 돌린다(등록 자격 검사)',
        '  gate run [<suite>] [--rule <id>] [--fresh] [--verbose] [--lang ko|en]',
        '                              결정적 레인을 돌리고, 할 일을 지시문으로 낸다',
        '  gate suites                 정의된 스위트와 그 소속 게이트를 보여준다',
        '  gate judge <rule> --verdict <파일>',
        '                              판정자가 쓴 답을 받아 커버리지를 검사하고 기록한다',
        '  gate mask <rule> <code> --reason "<왜 위반이 아닌가>" [--until YYYY-MM-DD]',
        '                              그 결함/후보를 면제한다 — 게이트가 실제로 낸 것만',
        '  gate pending                판정 대기 중인 요청을 출력한다(호스트가 읽는다)',
        '  gate status                 게이트별 상태(unproven|red|green|stale|skipped|broken)',
        '',
        '공통 옵션',
        '  --json                      기계용 JSON (= --format json). 색을 담지 않는다',
        '  --format json|instruct|pretty',
        '                              instruct = LLM 지시문(기본) · pretty = instruct + 색 강제',
        '  --color auto|always|never   auto = TTY 이고 NO_COLOR 가 없을 때만 (기본)',
        '  --cwd <dir>',
        '',
        '종료 코드: 0 통과 · 1 실패 · 2 사용법 · 3 차단 · 20 판정 필요',
        '  3 = 미판정 · broken · stale · unproven(red 미시연) · 고른 게이트 0개 · 선언된 룰 누락',
        '',
      ].join('\n'),
    );
    return EXIT.PASS;
  }

  if (cmd === 'init') {
    mkdirSync(join(cwd, 'gates'), { recursive: true });
    const cfg = join(cwd, 'gate.config.mjs');
    if (!existsSync(cfg)) {
      writeFileSync(
        cfg,
        [
          "import { defineConfig, subject } from 'gate-kernel'",
          '',
          'export default defineConfig({',
          "  rules: ['gates/**/*.rule.mjs'],",
          '  // 룰이 subject 를 지정하지 않으면 이걸 쓴다',
          '  subject: subject.diff({ base: \'auto\' }),',
          "  failAt: 'high',",
          '})',
          '',
        ].join('\n'),
        'utf8',
      );
    }
    process.stdout.write(`생성: ${cfg}, ${join(cwd, 'gates')}/\n`);
    return EXIT.PASS;
  }

  const config = await loadConfig(cwd);
  let rules: RuleSpec[];
  try {
    rules = await loadRules(cwd, config);
  } catch (e) {
    if (!(e instanceof RuleRegistryError)) throw e;
    // 선언된 룰이 없으면 어떤 명령도 그 레지스트리 위에서 돌지 않는다. 남은 룰로
    // 통과를 내는 순간 "적어 둔 게이트가 사라졌다" 는 사실이 exit 0 뒤로 숨는다.
    process.stderr.write(`${e.message}\n`);
    return EXIT.BLOCKED;
  }
  const only = flag('rule') ? [flag('rule')!] : undefined;
  // 첫 위치 인자가 스위트 이름인 명령은 정해져 있다: `gate run docs`. 플래그로도 받는다.
  // `judge`/`mask` 의 첫 인자는 룰 id 라, 여기서 구별하지 않으면 룰 이름을 스위트로
  // 읽어 "알 수 없는 스위트" 로 죽는다 — 판정 루프가 첫 라운드에서 끊긴다.
  const takesSuite = cmd === 'run' || cmd === 'list' || cmd === 'status';
  const positional = takesSuite && argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;
  const suiteName = flag('suite') ?? positional;
  const suite = resolveSuite(config, suiteName);
  const selection = selectRules(rules, suite, only);
  const selected: RuleSpec[] = selection.targets;
  const { json, color } = outputMode(suite.config.output);
  const lang = (flag('lang') as Lang | undefined) ?? suite.config.output?.lang;

  // 스위트가 요구한 룰이 선택에 없으면 그 스위트로는 돌지 않는다. `list`/`suites` 는
  // 진단용이라 통과시킨다 — 무엇이 빠졌는지 보려면 그 명령이 필요하다.
  const runsSelection = cmd === 'run' || cmd === 'prove' || cmd === 'status';
  if (runsSelection && selection.missing.length) {
    process.stderr.write(
      `스위트 ${suite.name} 가 요구한 룰이 선택에 없다: ${selection.missing.join(', ')}\n` +
        '태그·include 를 확인해라. 빠진 채로 돌리면 이 스위트는 선언보다 약한 보증을 같은 이름으로 낸다.\n',
    );
    return EXIT.BLOCKED;
  }

  if (cmd === 'list') {
    if (json) return out(selected.map((r) => ({ id: r.id, lane: r.lane, criterion: r.criterion, source: r.source }))), EXIT.PASS;
    process.stdout.write(renderList(selected, { color, lang }));
    return EXIT.PASS;
  }

  if (cmd === 'suites') {
    const names = Object.keys(config.suites ?? {});
    if (!names.length) {
      process.stdout.write(
        '정의된 스위트가 없다 — 모든 게이트가 한 번에 돈다.\n' +
          'gate.config 에 suites 를 추가하면 축별로 나눠 돌릴 수 있다.\n',
      );
      return EXIT.PASS;
    }
    const rows = names.map((n) => {
      const s = resolveSuite(config, n);
      const sel = selectRules(rules, s);
      return { name: n, include: s.include, exclude: s.exclude, rules: sel.targets.map((r) => r.id) };
    });
    if (json) return out(rows), EXIT.PASS;
    for (const r of rows) {
      const def = r.name === config.defaultSuite ? ' (기본)' : '';
      process.stdout.write(`${r.name}${def}  ${r.include.join(' ')}${r.exclude.length ? ` − ${r.exclude.join(' ')}` : ''}\n`);
      for (const id of r.rules) process.stdout.write(`    ${id}\n`);
    }
    return EXIT.PASS;
  }

  if (cmd === 'prove') {
    const results = await Promise.all(selected.map((r) => prove(r)));
    // 픽스처로 red 를 시연했으면 그것이 곧 red-first 증명이다 — 실행에서 실제
    // 위반이 나올 때까지 기다리지 않는다.
    const proveDir = storeDirOf(cwd, config);
    for (const r of results) {
      if (r.demonstratesRed) verdicts.markProvenRed(proveDir, r.rule, 'prove');
    }
    if (json) out(results);
    else process.stdout.write(renderProve(results, { color, lang }));
    // 빈 배열의 `every` 는 참이다 — 아무것도 증명하지 않은 것이 전부 증명한 것으로
    // 읽히지 않게, 선택이 비었으면 `run` 과 같은 규칙으로 막는다.
    if (!results.length && !suite.config.coverage.allowEmpty) {
      process.stderr.write('고른 게이트가 0개다. 아무것도 증명하지 않은 실행은 통과가 아니다.\n');
      return EXIT.BLOCKED;
    }
    return results.every((r) => r.ok) ? EXIT.PASS : EXIT.FAIL;
  }

  if (cmd === 'run') {
    const result = await run({
      cwd,
      config: suite.config,
      rules: selected,
      fresh: has('fresh'),
    });
    if (json) out(result);
    else {
      process.stdout.write(
        renderRun(result, selected, {
          cwd,
          storeDir: storeDirOf(cwd, suite.config),
          lang,
          verbose: has('verbose') || suite.config.output?.verbose === true,
          projectContext: suite.config.judge?.projectContext === true,
          inlineJudge: suite.config.judge?.delegate === 'inline',
          failAt: suite.config.failAt,
          suite: suite.name === ALL_SUITE ? undefined : suite.name,
          unclassified: selection.unclassified.map((r) => r.id),
          color,
        }),
      );
    }
    if (result.pending.length) return EXIT.JUDGE_REQUIRED;
    return result.outcome === 'fail' ? EXIT.FAIL : result.outcome === 'blocked' ? EXIT.BLOCKED : EXIT.PASS;
  }

  if (cmd === 'judge') {
    const ruleId = argv[1];
    const file = flag('verdict');
    if (!ruleId || ruleId.startsWith('--') || !file) {
      process.stderr.write('사용법: gate judge <rule> --verdict <답을 적은 파일>\n');
      return EXIT.USAGE;
    }
    const dir = storeDirOf(cwd, config);
    const open = pendingRequests(dir).filter((r) => r.rule === ruleId);
    if (!open.length) {
      process.stderr.write(
        `${ruleId} 에 대기 중인 판정 요청이 없다. \`gate run\` 을 먼저 돌려라.\n`,
      );
      return EXIT.USAGE;
    }
    // writeRequest 가 옛 슬롯을 지우므로 룰당 미응답 요청은 최대 하나다.
    const req = open[0]!;
    if (!existsSync(file)) {
      process.stderr.write(`판정 파일이 없다: ${file}\n`);
      return EXIT.USAGE;
    }
    let res: JudgeResponse;
    try {
      res = normalizeResponse(req, JSON.parse(readFileSync(file, 'utf8')));
      // 기록하기 전에 커버리지를 검사한다. 계약을 어긴 답을 먼저 쓰면 그 답이
      // 캐시가 돼, 다시 물을 기회 없이 미판정이 판정으로 굳는다.
      ingest(req, res);
    } catch (e) {
      const why = e instanceof JudgeContractError || e instanceof SyntaxError ? e.message : String(e);
      process.stderr.write(`판정을 받지 않았다 — ${why}\n판정자에게 다시 물어라.\n`);
      return EXIT.BLOCKED;
    }
    writeResponse(dir, req, res);
    const violating = res.decisions.filter((d) => d.violates).length;
    if (json) return out({ rule: ruleId, round: req.round, violating, at: responsePath(dir, req) }), EXIT.PASS;
    process.stdout.write(
      `${ruleId} r${req.round} 판정 기록됨 — 후보 ${res.decisions.length}건 중 ${violating}건 위반.\n` +
        '`gate run` 을 다시 돌려라.\n',
    );
    return EXIT.PASS;
  }

  if (cmd === 'mask') {
    const ruleId = argv[1];
    const code = argv[2];
    const reason = flag('reason');
    const until = flag('until');
    if (!ruleId || !code || code.startsWith('--')) {
      process.stderr.write('사용법: gate mask <rule> <code> --reason "<왜 위반이 아닌가>" [--until YYYY-MM-DD]\n');
      return EXIT.USAGE;
    }
    if (!reason?.trim()) {
      process.stderr.write('`--reason` 은 필수다 — 사유 없는 면제는 게이트를 조용히 끄는 스위치다.\n');
      return EXIT.USAGE;
    }
    if (until != null && parseUntil(until) == null) {
      process.stderr.write(`\`--until\` 은 YYYY-MM-DD 또는 ISO 8601 이어야 한다: ${until}\n`);
      return EXIT.USAGE;
    }
    const dir = storeDirOf(cwd, config);
    const found = locateCode(dir, ruleId, code);
    if (!found) {
      // 게이트가 낸 적 없는 것은 면제할 수 없다. 손으로 넓은 면제를 미리 깔아
      // 두는 경로를 아예 없애는 것이 이 제약의 목적이다.
      process.stderr.write(
        `${ruleId} 가 '${code}' 를 낸 기록이 없다. \`gate run\` 으로 실제로 나온 code 만 면제할 수 있다.\n`,
      );
      return EXIT.USAGE;
    }
    const entries: MaskSpec[] = found.locations.map((l) => ({
      file: l.file,
      ...(l.line != null ? { line: l.line } : {}),
      ...(l.column != null ? { column: l.column } : {}),
      ...(l.endColumn != null ? { endColumn: l.endColumn } : {}),
      code: found.code,
      reason: reason.trim(),
      ...(until ? { until } : {}),
    }));
    const file: MaskFile = loadMaskFile(cwd, config.masks);
    file[ruleId] = [...(file[ruleId] ?? []), ...entries];
    const at = saveMaskFile(cwd, file, config.masks);
    if (json) return out({ rule: ruleId, code: found.code, entries, file: at }), EXIT.PASS;
    process.stdout.write(
      `${found.code} 면제 ${entries.length}건을 ${maskFilePath(cwd, config.masks)} 에 적었다.\n` +
        `${until ? `${until} 에 만료된다.` : '만료가 없다 — 게이트가 틀린 것이 아니라 부채라면 --until 을 붙여라.'}\n` +
        '이 파일은 커밋해라. 리뷰되지 않는 면제는 게이트를 끈 것과 같다.\n',
    );
    return EXIT.PASS;
  }

  if (cmd === 'pending') {
    const reqs = pendingRequests(storeDirOf(cwd, config));
    out(reqs);
    return reqs.length ? EXIT.JUDGE_REQUIRED : EXIT.PASS;
  }

  if (cmd === 'status') {
    const dir = storeDirOf(cwd, config);
    const rows: StatusRow[] = selected.map((r) => {
      const v = verdicts.load(dir, r.id);
      const provenRed = verdicts.hasProvenRed(dir, r.id);
      return {
        id: r.id,
        lane: r.lane,
        // 저장된 state 를 그대로 읽지 않는다 — red 시연은 판정을 캐시한 뒤에도
        // 성립할 수 있어서, 결함 수 × 시연 여부로 매번 다시 판정한다.
        state: v ? verdicts.stateOf({ hasFindings: v.findings.length > 0, provenRed }) : 'unproven',
        provenRed,
        findings: v?.findings.length ?? 0,
        criterion: r.criterion,
      };
    });
    if (json) out(rows);
    else process.stdout.write(renderStatus(rows, { color, lang }));
    // `run` 과 같은 계약이다. 상태만 읽는 명령이 실행 명령과 다른 종료 코드를 내면
    // 호스트는 둘 중 하나를 골라 믿어야 한다.
    if (rows.some((r) => r.state === 'red')) return EXIT.FAIL;
    if (!rows.length && !suite.config.coverage.allowEmpty) return EXIT.BLOCKED;
    const notConclusive = rows.some(
      (r) => r.state === 'stale' || r.state === 'broken' || (r.state === 'unproven' && suite.config.coverage.requireProven),
    );
    return notConclusive ? EXIT.BLOCKED : EXIT.PASS;
  }

  process.stderr.write(`알 수 없는 명령: ${cmd}\n`);
  return EXIT.USAGE;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(EXIT.USAGE);
    }
    process.stderr.write(`${(e as Error).stack ?? String(e)}\n`);
    process.exit(EXIT.BLOCKED);
  },
);
