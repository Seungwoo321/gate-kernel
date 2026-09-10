/**
 * 러너가 내는 모든 사람/LLM 대면 문구. **한 곳에 모아 둔다** — 출력이 이
 * 프레임워크의 인터페이스이기 때문이다. 소비자가 LLM 이면 산문이 곧 API 라서,
 * 문구가 코드 곳곳에 흩어지면 인터페이스가 흩어진다.
 *
 * 모든 문장은 **읽는 쪽에게 하는 명령문**이다. 상태를 서술하면("판단이 필요한
 * 항목이 있습니다") LLM 은 행동하는 대신 사용자에게 요약해 보고하고 끝낸다.
 */

export type Lang = 'ko' | 'en';

export interface Tally {
  total: number;
  passed: number;
  fix: number;
  ask: number;
  repair: number;
  /** red 를 시연한 적 없어 증거가 못 되는 게이트. 통과와 분리해서 센다. */
  unproven: number;
  /** 적용 대상이 아니어서 안 돈 게이트. 통과와 **분리해서** 센다. */
  skipped: number;
}

export interface JudgeBlockArgs {
  slicePath: string;
  ask: string;
  because: string;
  judgeCmd: string;
  maskCmd: string;
}

export interface Strings {
  /** 헤더 한 줄. `gate ✗ blocked — 12개 중 9 통과 · 2 위반 · 1 판정 대기` */
  header(outcome: string, mark: string, t: Tally): string;
  noRules(configHint: string): string;
  /** 빈 선택이 `allowEmpty` 로 허용됐다. 통과지만 검사한 것은 없다고 말한다. */
  noRulesAllowed(): string;
  nothingToDo(): string;

  todoHeading(): string;
  /** 어떤 스위트를 돌렸는지. 무엇이 안 돌았는지를 읽는 쪽이 알아야 한다. */
  suiteLine(name: string): string;
  /** 분류 축 소제목. 태그의 최상위 마디가 그대로 들어온다. */
  axisHeading(axis: string): string;
  unclassifiedAxis(): string;
  warnUnclassified(ids: string[]): string;
  verbFix(): string;
  verbAsk(): string;
  verbRepair(): string;
  /** red 시연이 없어 막힌 게이트에 대한 동사. */
  verbProve(): string;
  askSelfJudgeWarning(): string;
  rerun(cmd: string): string;

  labelCriterion(): string;
  labelViolation(): string;
  labelHow(): string;
  labelCandidates(): string;
  labelReason(): string;

  moreFindings(n: number): string;

  /** 판정 블록의 본문 — 이 프레임워크에서 가장 무거운 지시문이다. */
  judgeBlock(a: JudgeBlockArgs): string;
  brokenBlock(reason: string): string;
  /** 통과를 막는 `unproven`. 할 일 목록의 상세 블록이다. */
  proveBlock(): string;

  advisoryHeading(): string;
  unprovenBlock(rule: string, criterion: string): string;
  /** 차단 등급 아래의 결함. 할 일 목록에 섞지 않는다. */
  advisoryBlock(rule: string, criterion: string, items: string[]): string;
  /** 기한이 지나 효력을 잃은 면제. 결함이 왜 되돌아왔는지를 말해 준다. */
  expiredMaskBlock(rule: string, entries: string[]): string;

  skippedHeading(): string;
  skippedBlock(rule: string, reason: string): string;

  footerBlocked(): string;
  /** `fail` 이 `blocked` 를 가리므로, 남은 판정을 여기서 같이 말한다. */
  footerFail(pending: number): string;
  footerPass(): string;

  warnProjectContext(): string;
  warnInlineJudge(): string;
  /** `coverage.requireProven` 이 꺼져 있다 — unproven 이 통과로 접힌다. */
  warnRequireProvenOff(): string;
  /** 게이트는 있는데 전부 skipped 라 실제로 판정한 것이 없다. */
  noteNothingExecuted(): string;
}

const ko: Strings = {
  header: (outcome, mark, t) => {
    const parts = [`${t.passed}개 통과`];
    if (t.fix) parts.push(`${t.fix}개 위반`);
    if (t.ask) parts.push(`${t.ask}개 판정 대기`);
    if (t.repair) parts.push(`${t.repair}개 게이트 고장`);
    if (t.unproven) parts.push(`${t.unproven}개 미증명`);
    if (t.skipped) parts.push(`${t.skipped}개 미적용`);
    return `gate ${mark} ${outcome} — ${t.total}개 중 ${parts.join(' · ')}`;
  },
  noRules: (hint) =>
    `gate — 고른 게이트가 0개다. 아무것도 검사하지 않은 실행은 통과가 아니다. ${hint}\n` +
    '  의도적으로 빈 스위트라면 gate.config 의 `coverage.allowEmpty: true` 로 명시해라.',
  noRulesAllowed: () => 'gate — 고른 게이트가 0개다(allowEmpty). 통과로 치지만 검사한 것은 없다.',
  nothingToDo: () => '할 일 없다. 계속 진행해라.',

  todoHeading: () => '지금 할 일',
  suiteLine: (name) => `스위트: ${name}`,
  axisHeading: (axis) => `${axis}/`,
  unclassifiedAxis: () => '(분류 없음)',
  warnUnclassified: (ids) =>
    `⚠ 태그 없는 게이트 ${ids.length}개가 스위트와 무관하게 항상 돈다: ${ids.join(', ')}\n` +
    '  분류를 안 하면 스위트로 골라 낼 수 없다. 각 게이트에 `tags: [\'축/하위축\']` 를 달아라.',
  verbFix: () => '고쳐라',
  verbAsk: () => '물어라',
  verbRepair: () => '게이트를 고쳐라',
  verbProve: () => 'red 를 시연해라',
  askSelfJudgeWarning: () => '← 직접 판정하지 마라',
  rerun: (cmd) =>
    `다 끝냈으면 \`${cmd}\` 을 다시 돌려라.\n` +
    `    outcome: pass 가 나오기 전에는 이 작업은 끝난 게 아니다.`,

  labelCriterion: () => '기준',
  labelViolation: () => '위반',
  labelHow: () => '방법',
  labelCandidates: () => '후보',
  labelReason: () => '사유',

  moreFindings: (n) => `외 ${n}건 더 있다. 전부 고쳐라 — \`--json\` 으로 전체 목록을 받는다.`,

  judgeBlock: (a) =>
    [
      `  이건 문자열로 판정할 수 없다 — ${a.because}`,
      `  판정은 LLM 몫이다. 다만 네가 직접 하지 마라: 이 코드를 방금 네가 고쳤다면`,
      `  같은 맹점이 검증을 그대로 통과한다.`,
      '',
      '  이대로 해라',
      '    1) 서브에이전트를 띄운다.',
      `    2) ${a.slicePath} 를 준다.`,
      '       근거는 이미 다 잘라 놨다. 그 파일 밖은 읽지 말라고 해라 —',
      '       슬라이스 밖을 보기 시작하면 판정이 돌릴 때마다 달라진다.',
      '    3) 이렇게 묻는다:',
      `       "${a.ask}`,
      '        슬라이스의 candidates 에 있는 **모든 code 에** 답해라 —',
      '        하나라도 빠지면 그 후보는 통과가 아니라 미판정으로 처리된다.',
      '        답은 JSON 파일 하나로 써라:',
      '        {"decisions":[{"code":"…","violates":true,',
      '                       "why":"어디가 어떻게 어긋나는가 — file:line"}]}"',
      '    4) 그 파일을 그대로 넘긴다:',
      `       ${a.judgeCmd}`,
      '',
      '  답이 위반이면 → 코드를 고쳐라.',
      '  답이 위반 아님이면 → 사유를 남겨라. 다음부터 안 묻는다:',
      `       ${a.maskCmd}`,
    ].join('\n'),

  brokenBlock: (reason) =>
    [
      `  이 게이트가 돌다 죽었다 — ${reason}`,
      '  검사 대상이 아니라 게이트 코드의 문제다. 게이트를 고쳐라.',
      '  못 고치겠으면 지워라. 깨진 채로 두면 통과처럼 보인다.',
    ].join('\n'),
  proveBlock: () =>
    [
      '  이 게이트는 결함 0 건이지만 red 를 한 번도 낸 적이 없다.',
      '  실패를 보여준 적 없는 게이트의 초록은 증거가 아니다 — 아무것도 안 하는 게이트와 구별되지 않는다.',
      '  `prove` 에 위반 픽스처를 하나 넣고 `gate prove --rule <id>` 를 돌려라. 통과하면 이 게이트는 green 이 된다.',
    ].join('\n'),

  advisoryHeading: () => '통과를 막지는 않지만 알아 둬라',
  unprovenBlock: (rule, criterion) =>
    [
      `  ${rule} 은 red 를 한 번도 못 보였다 — "${criterion}"`,
      '  실패를 보여준 적 없는 게이트의 초록은 아직 증거가 아니다.',
      `  \`prove\` 에 위반 픽스처를 하나 넣어라.`,
    ].join('\n'),
  advisoryBlock: (rule, criterion, items) =>
    [
      `  ${rule} — "${criterion}"`,
      ...items.map((i) => `    ${i}`),
      '  차단 등급 아래라 통과를 막지 않는다. 고칠지는 네가 정해라.',
    ].join('\n'),
  expiredMaskBlock: (rule, entries) =>
    [
      `  ${rule} 의 면제 ${entries.length}건이 기한을 넘겼다:`,
      ...entries.map((e) => `    ${e}`),
      '  그래서 그 결함이 위에 다시 올라와 있다. 고치거나, 사유를 새로 적고 기한을 다시 잡아라.',
    ].join('\n'),

  skippedHeading: () => '이번엔 안 돌았다',
  skippedBlock: (rule, reason) =>
    [
      `  ${rule} — ${reason}`,
      '  적용 대상이 아니라 건너뛰었다. **통과가 아니라 미적용이다.**',
    ].join('\n'),

  footerBlocked: () => 'outcome: blocked — 아직 결론이 아니다. 위 할 일을 끝내고 다시 돌려라.',
  footerFail: (pending) =>
    pending > 0
      ? `outcome: fail — 위반이 있다. 판정도 ${pending}건 남았다. 둘 다 끝내라.`
      : 'outcome: fail — 위반이 있다.',
  footerPass: () => 'outcome: pass',

  warnProjectContext: () =>
    '⚠ judge.projectContext 가 켜져 있다 — 판정에 프로젝트 문서가 섞인다.\n' +
    '  그 문서는 subjectHash 에 안 잡히므로, 문서가 바뀌어도 재판정되지 않는다.',
  warnInlineJudge: () =>
    '⚠ judge.delegate 가 inline 이다 — 산출자가 자기 산출을 판정한다.\n' +
    '  같은 맹점이 검증을 통과할 수 있다.',
  warnRequireProvenOff: () =>
    '⚠ coverage.requireProven 이 꺼져 있다 — red 를 시연한 적 없는 게이트가 통과로 접힌다.\n' +
    '  결함 0 건과 검사 안 함이 구별되지 않는다. 픽스처를 붙이고 다시 켜라.',
  noteNothingExecuted: () =>
    '⚠ 고른 게이트가 전부 미적용이라 실제로 판정한 것이 없다. 통과로 치지만 검사한 것은 없다.',
};

const en: Strings = {
  header: (outcome, mark, t) => {
    const parts = [`${t.passed} passed`];
    if (t.fix) parts.push(`${t.fix} violating`);
    if (t.ask) parts.push(`${t.ask} awaiting judgment`);
    if (t.repair) parts.push(`${t.repair} broken`);
    if (t.unproven) parts.push(`${t.unproven} unproven`);
    if (t.skipped) parts.push(`${t.skipped} not applicable`);
    return `gate ${mark} ${outcome} — ${parts.join(' · ')} of ${t.total}`;
  },
  noRules: (hint) =>
    `gate — 0 gates selected. A run that inspected nothing is not a pass. ${hint}\n` +
    '  If the empty suite is intentional, say so with `coverage.allowEmpty: true` in gate.config.',
  noRulesAllowed: () => 'gate — 0 gates selected (allowEmpty). Counted as a pass, but nothing was inspected.',
  nothingToDo: () => 'Nothing to do. Carry on.',

  todoHeading: () => 'Do this now',
  suiteLine: (name) => `suite: ${name}`,
  axisHeading: (axis) => `${axis}/`,
  unclassifiedAxis: () => '(unclassified)',
  warnUnclassified: (ids) =>
    `⚠ ${ids.length} untagged gate(s) always run regardless of suite: ${ids.join(', ')}\n` +
    "  Without tags they cannot be selected by suite. Add `tags: ['axis/sub-axis']` to each.",
  verbFix: () => 'Fix',
  verbAsk: () => 'Ask',
  verbRepair: () => 'Repair the gate',
  verbProve: () => 'Demonstrate red',
  askSelfJudgeWarning: () => '← do not judge this yourself',
  rerun: (cmd) =>
    `When all of the above is done, run \`${cmd}\` again.\n` +
    `    You are not finished until outcome: pass.`,

  labelCriterion: () => 'Criterion',
  labelViolation: () => 'Violation',
  labelHow: () => 'How',
  labelCandidates: () => 'Candidates',
  labelReason: () => 'Reason',

  moreFindings: (n) => `${n} more. Fix them all — use \`--json\` for the full list.`,

  judgeBlock: (a) =>
    [
      `  This cannot be decided by string matching — ${a.because}`,
      `  An LLM has to judge it. But not you: if you just wrote this code, the same`,
      `  blind spot will pass its own review.`,
      '',
      '  Do exactly this',
      '    1) Spawn a subagent.',
      `    2) Give it ${a.slicePath}.`,
      '       The evidence is already sliced. Tell it not to read outside that file —',
      '       once it looks outside the slice, the verdict changes every run.',
      '    3) Ask:',
      `       "${a.ask}`,
      '        Answer **every code** in the slice\'s candidates —',
      '        any you leave out is treated as unjudged, not as passing.',
      '        Write the answer as one JSON file:',
      '        {"decisions":[{"code":"…","violates":true,',
      '                       "why":"where and how it breaks — file:line"}]}"',
      '    4) Pass that file straight back:',
      `       ${a.judgeCmd}`,
      '',
      '  If the answer is "violates" → fix the code.',
      '  If the answer is "does not violate" → record why. It will not ask again:',
      `       ${a.maskCmd}`,
    ].join('\n'),

  brokenBlock: (reason) =>
    [
      `  This gate died while running — ${reason}`,
      '  That is a bug in the gate, not in what it inspects. Repair it.',
      '  If you cannot, delete it. A broken gate reads as a passing one.',
    ].join('\n'),
  proveBlock: () =>
    [
      '  This gate found nothing, but it has never produced red.',
      '  A gate that has never failed has not earned its green — it is indistinguishable from a gate that does nothing.',
      '  Add one violating fixture to `prove` and run `gate prove --rule <id>`. Once it passes, this gate turns green.',
    ].join('\n'),

  advisoryHeading: () => 'Not blocking, but know this',
  unprovenBlock: (rule, criterion) =>
    [
      `  ${rule} has never demonstrated red — "${criterion}"`,
      '  A gate that has never failed has not yet earned its green.',
      '  Add one violating fixture to `prove`.',
    ].join('\n'),
  advisoryBlock: (rule, criterion, items) =>
    [
      `  ${rule} — "${criterion}"`,
      ...items.map((i) => `    ${i}`),
      '  Below the blocking threshold. Whether to fix it is your call.',
    ].join('\n'),
  expiredMaskBlock: (rule, entries) =>
    [
      `  ${entries.length} mask(s) on ${rule} are past their expiry:`,
      ...entries.map((e) => `    ${e}`),
      '  That is why those findings are back above. Fix them, or write a new reason and a new date.',
    ].join('\n'),

  skippedHeading: () => 'Did not run this time',
  skippedBlock: (rule, reason) =>
    [
      `  ${rule} — ${reason}`,
      '  Not applicable to this subject, so it was skipped. **That is not a pass.**',
    ].join('\n'),

  footerBlocked: () => 'outcome: blocked — not a conclusion yet. Finish the items above and run again.',
  footerFail: (pending) =>
    pending > 0
      ? `outcome: fail — there are violations, and ${pending} judgment(s) outstanding. Finish both.`
      : 'outcome: fail — there are violations.',
  footerPass: () => 'outcome: pass',

  warnProjectContext: () =>
    '⚠ judge.projectContext is on — project docs leak into judgment.\n' +
    '  They are not covered by subjectHash, so changing them will not trigger re-judgment.',
  warnInlineJudge: () =>
    '⚠ judge.delegate is inline — the producer is validating its own output.\n' +
    '  The same blind spot can pass review.',
  warnRequireProvenOff: () =>
    '⚠ coverage.requireProven is off — gates that never demonstrated red are folded into pass.\n' +
    '  Zero findings and no inspection are no longer distinguishable. Add fixtures and turn it back on.',
  noteNothingExecuted: () =>
    '⚠ Every selected gate was not applicable, so nothing was actually judged. Counted as a pass, but nothing was inspected.',
};

const TABLE: Record<Lang, Strings> = { ko, en };

export function strings(lang: Lang = 'ko'): Strings {
  return TABLE[lang] ?? ko;
}
