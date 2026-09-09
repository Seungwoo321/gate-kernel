import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { rule, subject, RuleDefinitionError } from '../dist/index.js'
import { prove, run, runScan, ingest, buildRequest, matches, matchesTag, resolveSubject, resolveSuite, selectRules, applyMaskFile, maskRev, isExpired } from '../dist/runtime.js'
import { resolveConfig } from '../dist/index.js'
import { stalenessOf, stateOf, hasProvenRed, markProvenRed } from '../dist/store/verdicts.js'

const slice = (files, data = null) => ({
  kind: 'tree',
  files: Object.entries(files).map(([path, v]) => (typeof v === 'string' ? { path, text: v } : { path, ...v })),
  data,
  meta: {},
  hash: 'h',
})

// --- 등록 시점 불변식 -------------------------------------------------------

test('결정적 좁히기가 없으면 등록을 거부한다', () => {
  assert.throws(
    () => rule('x', { criterion: 'c' }),
    (e) => e instanceof RuleDefinitionError && /좁히기/.test(e.message),
  )
})

test('judge.because 가 없으면 등록을 거부한다', () => {
  assert.throws(
    () =>
      rule('x', {
        criterion: 'c',
        scan: () => ({ findings: [], candidates: [] }),
        judge: { ask: 'q' },
      }),
    (e) => /because/.test(e.message),
  )
})

test('judge 가 있는데 scan 이 없으면 등록을 거부한다', () => {
  assert.throws(
    () => rule('x', { criterion: 'c', detect: /a/, judge: { because: 'b', ask: 'q' } }),
    (e) => /후보/.test(e.message),
  )
})

test('사유 없는 mask 는 등록을 거부한다', () => {
  assert.throws(
    () => rule('x', { criterion: 'c', detect: /a/, mask: [{ file: 'a.ts', reason: '' }] }),
    (e) => /reason/.test(e.message),
  )
})

test('red 를 시연하지 못하면 unproven 태그가 붙는다', () => {
  const r = rule('x', { criterion: 'c', detect: /a/ })
  assert.ok(r.tags.includes('unproven'))
  const p = rule('y', {
    criterion: 'c',
    detect: /a/,
    prove: [{ name: 'n', files: { 'a.ts': 'a' }, expect: 'red' }],
  })
  assert.ok(!(p.tags ?? []).includes('unproven'))
})

// --- 레인 판정 --------------------------------------------------------------

test('judge 유무로 레인이 갈린다', () => {
  assert.equal(rule('a', { criterion: 'c', detect: /x/ }).lane, 'deterministic')
  assert.equal(
    rule('b', {
      criterion: 'c',
      scan: () => ({ findings: [], candidates: [] }),
      judge: { because: 'b', ask: 'q' },
    }).lane,
    'hybrid',
  )
})

// --- 결정적 레인 ------------------------------------------------------------

test('detect 는 컬럼까지 짚는다', async () => {
  const r = rule('no-todo', { criterion: 'TODO 금지', detect: /TODO/ })
  const out = await runScan(r, slice({ 'a.ts': 'let x = 1 // TODO fix' }), {})
  assert.equal(out.findings.length, 1)
  assert.equal(out.findings[0].locations[0].line, 1)
  assert.equal(out.findings[0].locations[0].column, 14)
  assert.equal(out.findings[0].locations[0].endColumn, 18)
})

test('addedLines 가 있으면 추가된 줄만 본다', async () => {
  const r = rule('no-todo', { criterion: 'TODO 금지', detect: /TODO/ })
  const out = await runScan(r, slice({ 'a.ts': { text: '// TODO old\n// TODO new', addedLines: [2] } }), {})
  assert.equal(out.findings.length, 1)
  assert.equal(out.findings[0].locations[0].line, 2)
})

test('마스크는 컬럼 정밀이라 같은 줄의 다른 결함을 삼키지 않는다', async () => {
  const base = { criterion: 'TODO 금지', detect: /TODO/ }
  const masked = rule('no-todo', {
    ...base,
    mask: [{ file: 'a.ts', line: 1, column: 1, endColumn: 5, reason: '헤더 배너' }],
  })
  const out = await runScan(masked, slice({ 'a.ts': 'TODO banner and TODO real' }), {})
  assert.equal(out.masked, 1)
  assert.equal(out.findings.length, 1)
  assert.equal(out.findings[0].locations[0].column, 17)
})

test('severityCap 은 축 전체의 심각도를 눌러 앉힌다 (어드바이저리 게이트)', async () => {
  const r = rule('advisory', { criterion: 'c', detect: /X/, severity: 'critical', severityCap: 'info' })
  const out = await runScan(r, slice({ 'a.ts': 'X' }), {})
  assert.equal(out.findings[0].severity, 'info')
})

test('슬라이스 밖 읽기는 던진다 (폐쇄성)', async () => {
  const r = rule('closed', {
    criterion: 'c',
    scan: (ctx) => {
      ctx.read('outside.ts')
      return { findings: [], candidates: [] }
    },
  })
  await assert.rejects(() => runScan(r, slice({ 'a.ts': 'x' }), {}), /슬라이스 밖/)
})

test('line 0 은 금지된다 (면제 우회 방지)', async () => {
  const r = rule('zero', {
    criterion: 'c',
    scan: (ctx) => ({ findings: [ctx.finding('x', 'm', [{ file: 'a.ts', line: 0 }])], candidates: [] }),
  })
  await assert.rejects(() => runScan(r, slice({ 'a.ts': 'x' }), {}), /line 0/)
})

// --- 판정 레인 계약 ---------------------------------------------------------

const hybrid = rule('h', {
  criterion: 'c',
  scan: (ctx) => ({
    findings: [],
    candidates: [
      ctx.candidate('k', 'one', 'm1', [{ file: 'a.ts', line: 1 }]),
      ctx.candidate('k', 'two', 'm2', [{ file: 'a.ts', line: 2 }]),
    ],
  }),
  judge: { because: '문맥을 읽어야 갈린다', ask: '위반인가?' },
})

test('후보를 하나라도 빠뜨린 판정은 계약 위반이다 (커버리지 검증)', async () => {
  const s = slice({ 'a.ts': 'x\ny' })
  const scan = await runScan(hybrid, s, {})
  const req = buildRequest(hybrid, s, scan.candidates, { deadlineSeconds: 1, sliceChars: 100, round: 1 })
  assert.throws(
    () => ingest(req, { rule: 'h', key: req.key, round: 1, decisions: [{ code: 'h.one', violates: true, why: 'w' }] }),
    /미판정/,
  )
})

test('판정 결과는 후보 안에서만 나온다 (slice 폐쇄성)', async () => {
  const s = slice({ 'a.ts': 'x\ny' })
  const scan = await runScan(hybrid, s, {})
  const req = buildRequest(hybrid, s, scan.candidates, { deadlineSeconds: 1, sliceChars: 100, round: 1 })
  const findings = ingest(req, {
    rule: 'h',
    key: req.key,
    round: 1,
    decisions: [
      { code: 'h.one', violates: true, why: '같은 축이다' },
      { code: 'h.two', violates: false, why: '다른 축이다' },
      { code: 'h.ghost', violates: true, why: '없는 후보' },
    ],
  })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].code, 'h.one')
  assert.equal(findings[0].foundBy, 'judge')
})

test('판정 요청은 후보가 가리키는 파일만 물질화한다', async () => {
  const s = slice({ 'a.ts': 'x\ny', 'b.ts': '무관' })
  const scan = await runScan(hybrid, s, {})
  const req = buildRequest(hybrid, s, scan.candidates, { deadlineSeconds: 1, sliceChars: 100, round: 1 })
  assert.deepEqual(req.files.map((f) => f.path), ['a.ts'])
})

// --- staleness / lifecycle --------------------------------------------------

test('criterion 이 바뀌면 과거 판정은 stale 이다', () => {
  const r1 = rule('s', { criterion: '기준 A', detect: /x/ })
  const r2 = rule('s', { criterion: '기준 B', detect: /x/ })
  const prev = { criterionRev: r1.criterionRev, scanRev: r1.scanRev, maskRev: r1.maskRev, subjectHash: 'h' }
  assert.equal(stalenessOf(prev, r1, { hash: 'h' }).fresh, true)
  assert.equal(stalenessOf(prev, r2, { hash: 'h' }).reason, 'criterion-changed')
})

test('탐색 로직이 바뀌면 stale 이다', () => {
  const r1 = rule('s', { criterion: '기준', detect: /x/ })
  const r2 = rule('s', { criterion: '기준', detect: /y/ })
  const prev = { criterionRev: r1.criterionRev, scanRev: r1.scanRev, maskRev: r1.maskRev, subjectHash: 'h' }
  assert.equal(stalenessOf(prev, r2, { hash: 'h' }).reason, 'scan-changed')
})

test('red 를 낸 적 없으면 결함 0 은 green 이 아니라 unproven 이다', () => {
  assert.equal(stateOf({ hasFindings: false, provenRed: false }), 'unproven')
  assert.equal(stateOf({ hasFindings: false, provenRed: true }), 'green')
  assert.equal(stateOf({ hasFindings: true, provenRed: true }), 'red')
  assert.equal(stateOf({ hasFindings: false, provenRed: true, broken: '타임아웃' }), 'broken')
})

test('픽스처로 시연한 red 도 red-first 증명으로 인정된다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-proven-'))
  assert.equal(hasProvenRed(dir, 'r'), false)
  assert.equal(stateOf({ hasFindings: false, provenRed: hasProvenRed(dir, 'r') }), 'unproven')
  markProvenRed(dir, 'r', 'prove')
  assert.equal(hasProvenRed(dir, 'r'), true)
  assert.equal(stateOf({ hasFindings: false, provenRed: hasProvenRed(dir, 'r') }), 'green')
})

// --- prove ------------------------------------------------------------------

test('prove 는 red 시연 여부를 별도로 센다', async () => {
  const onlyGreen = rule('g', {
    criterion: 'c',
    detect: /zzz/,
    prove: [{ name: 'n', files: { 'a.ts': 'x' }, expect: 'green' }],
  })
  const r = await prove(onlyGreen)
  assert.equal(r.demonstratesRed, false)
  assert.equal(r.ok, false, 'green 만 통과하는 게이트는 자격이 없다')
})

test('prove 는 counterpart 픽스처로 두 트리 대조도 재현한다', async () => {
  const r = rule('drift', {
    criterion: 'c',
    scan: (ctx) => ({
      findings: ctx
        .files()
        .filter((f) => f.counterpart != null && f.counterpart !== f.text)
        .map((f) => ctx.finding('drifted', 'd', [{ file: f.path, line: 1 }])),
      candidates: [],
    }),
    prove: [
      { name: 'r', files: { 'a.md': { text: 'a', counterpart: 'b' } }, expect: 'red' },
      { name: 'g', files: { 'a.md': { text: 'a', counterpart: 'a' } }, expect: 'green' },
    ],
  })
  const out = await prove(r)
  assert.equal(out.ok, true)
})

// --- glob -------------------------------------------------------------------

test('글롭', () => {
  assert.ok(matches('src/handlers/a.ts', 'src/handlers/**/*.ts'))
  assert.ok(matches('src/a.ts', 'src/**/*.ts'))
  assert.ok(!matches('src/a.js', 'src/**/*.ts'))
  assert.ok(matches('docs/x/y/z.md', 'docs/**/*.md'))
  assert.ok(matches('a.rule.mjs', '**/*.rule.{mjs,js}'))
})

// --- 합성 대상 --------------------------------------------------------------

test('합성 대상은 축 이름으로 파일을 구별해 읽는다', async () => {
  const r = rule('composite', {
    criterion: '핀 변경은 합의가 있을 때만 통과한다',
    subject: subject.all({
      pin: subject.diff({ include: ['pins/*.json'] }),
      consent: subject.external('issues'),
    }),
    scan: (ctx) => {
      const changed = ctx.files().filter((f) => f.source === 'pin')
      const agreed = ctx.slice.data.consent.approvals
      // 축을 함께 봐야 성립하는 판정식 — 나누면 어느 쪽도 답을 못 낸다.
      return {
        findings: changed.length > 0 && agreed < 2
          ? [ctx.finding('no-consent', `합의 ${agreed}표`, [{ file: changed[0].path, line: 1 }])]
          : [],
        candidates: [],
      }
    },
  })
  // 대상은 데이터가 아니라 함수다 — 커널은 종류를 열거하지 않는다.
  assert.equal(typeof r.subject, 'function')

  const s = {
    kind: 'all',
    files: [{ path: 'pins/a.json', text: '{"rev":2}', source: 'pin' }],
    data: { pin: null, consent: { approvals: 1 } },
    meta: {},
    hash: 'h',
  }
  const out = await runScan(r, s, {})
  assert.equal(out.findings.length, 1)
  assert.equal(out.findings[0].code, 'composite.no-consent')

  const ok = await runScan(r, { ...s, data: { pin: null, consent: { approvals: 2 } } }, {})
  assert.equal(ok.findings.length, 0)
})

// --- 대상 개방성 ------------------------------------------------------------

test('커널이 모르는 대상도 그냥 함수로 쓴다', async () => {
  // 프레임워크의 핵심 주장: 새 대상을 위해 커널을 고칠 필요가 없다.
  // 아래 subject 는 stdlib 헬퍼가 아니라 게이트 파일에서 즉석으로 쓴 함수다.
  const 사내API = () => [
    { path: 'api/orders.yaml', text: 'summary: 주문' },
    { path: 'api/users.yaml', text: '' },
  ]

  const r = rule('spec-has-summary', {
    criterion: '모든 API 스펙에는 summary 가 있다',
    subject: (env) => ({ label: 'api-registry', files: 사내API(), meta: { cwd: env.cwd } }),
    scan: (ctx) => ({
      findings: ctx
        .files()
        .filter((f) => !f.text.includes('summary'))
        .map((f) => ctx.finding('no-summary', 'summary 누락', [{ file: f.path, line: 1 }])),
      candidates: [],
    }),
  })

  const env = { cwd: '/nowhere', config: {}, registry: [] }
  const s = await resolveSubject(r.subject, env)
  assert.equal(s.kind, 'api-registry')
  assert.equal(s.files.length, 2)
  // 해시는 커널이 붙인다 — 대상을 새로 만들어도 캐시·staleness 계약은 사용자가 못 건드린다.
  assert.match(s.hash, /^[0-9a-f]{8,}$/)

  const out = await runScan(r, s, {})
  assert.equal(out.findings.length, 1)
  assert.equal(out.findings[0].locations[0].file, 'api/users.yaml')

  // 좁히기도 커널이 보증한다 — subject 가 협조하지 않아도 결과는 같다.
  const narrowed = await resolveSubject(r.subject, env, ['api/orders.yaml'])
  assert.equal(narrowed.files.length, 1)
  assert.notEqual(narrowed.hash, s.hash)
})

test('분류 태그는 상위 마디가 하위 전체를 덮는다', () => {
  assert.ok(matchesTag('docs/terminology', ['docs']))
  assert.ok(matchesTag('docs/terminology', ['docs/**']))
  // 상위 마디만 단 게이트가 `docs/**` 에서 빠지면 조용한 누락이 된다.
  assert.ok(matchesTag('docs', ['docs/**']))
  assert.ok(matchesTag('docs/a/b', ['docs']))
  // 직계 자식만 원하면 단일 `*` — 확장하지 않는다.
  assert.ok(matchesTag('docs/a', ['docs/*']))
  assert.ok(!matchesTag('docs/a/b', ['docs/*']))
  assert.ok(!matchesTag('code/layering', ['docs/**']))
})

test('한 게이트가 여러 축에 동시에 속한다 — 트리가 아니라 패싯', () => {
  const cfg = resolveConfig({
    suites: { docs: { include: ['docs/**'] }, code: { include: ['code/**'] } },
  })
  const rules = [
    { id: 'term', tags: ['docs/terminology'] },
    { id: 'layer', tags: ['code/layering'] },
    { id: 'api-sync', tags: ['docs/api', 'code/contract'] },
  ]
  const inDocs = selectRules(rules, resolveSuite(cfg, 'docs')).targets.map((r) => r.id)
  const inCode = selectRules(rules, resolveSuite(cfg, 'code')).targets.map((r) => r.id)
  assert.deepEqual(inDocs, ['term', 'api-sync'])
  assert.deepEqual(inCode, ['layer', 'api-sync'])
})

test('스위트는 extends 로 합쳐지고 실행 규칙을 덮어쓴다', () => {
  const cfg = resolveConfig({
    failAt: 'high',
    suites: {
      docs: { include: ['docs/**'] },
      security: { include: ['security/**'], failAt: 'medium' },
      full: { extends: ['docs', 'security'] },
    },
  })
  const full = resolveSuite(cfg, 'full')
  assert.deepEqual(full.include.sort(), ['docs/**', 'security/**'])
  // 보안만 medium 부터 막는다 — 실행 규칙이 스위트에 붙는다.
  assert.equal(resolveSuite(cfg, 'security').config.failAt, 'medium')
  assert.equal(resolveSuite(cfg, 'docs').config.failAt, 'high')
})

test('태그 없는 게이트는 어떤 스위트에서도 빠지지 않는다 (fail-closed)', () => {
  const cfg = resolveConfig({ suites: { docs: { include: ['docs/**'] } } })
  const rules = [{ id: 'term', tags: ['docs/terminology'] }, { id: 'nameless' }]
  const sel = selectRules(rules, resolveSuite(cfg, 'docs'))
  // 분류 누락이 커버리지 누락으로 번지면 그 게이트는 통과처럼 보인다.
  assert.deepEqual(sel.targets.map((r) => r.id), ['term', 'nameless'])
  assert.deepEqual(sel.unclassified.map((r) => r.id), ['nameless'])
})

test('알 수 없는 스위트 이름은 조용히 전부 돌지 않고 실패한다', () => {
  const cfg = resolveConfig({ suites: { docs: { include: ['docs/**'] } } })
  assert.throws(() => resolveSuite(cfg, 'nope'), /알 수 없는 스위트/)
})

// --- 면제 -------------------------------------------------------------------

const HYBRID = (mask) =>
  rule('h', {
    criterion: '기준',
    mask,
    scan: (ctx) => ({
      findings: [],
      candidates: ctx
        .files()
        .map((f) =>
          ctx.candidate('call', `suspect-${f.path.replace(/[^a-z0-9]+/g, '-')}`, '의심', [
            { file: f.path, line: 1 },
          ]),
        ),
    }),
    judge: { ask: 'q', because: '문자열로 못 가린다' },
  })

test('면제는 결함뿐 아니라 후보도 거른다', async () => {
  const s = slice({ 'a.ts': 'x', 'b.ts': 'y' })
  const open = await runScan(HYBRID(), s, {})
  assert.equal(open.candidates.length, 2)

  // 후보를 안 거르면 "위반 아님" 판정을 남겨도 다음 실행이 같은 걸 또 묻는다.
  const masked = await runScan(HYBRID([{ file: 'a.ts', line: 1, reason: '의도된 호출' }]), s, {})
  assert.deepEqual(masked.candidates.map((c) => c.locations[0].file), ['b.ts'])
  assert.equal(masked.masked, 1)
})

test('기한이 지난 면제는 효력이 없고 결함이 되돌아온다', async () => {
  const s = slice({ 'a.ts': 'x' })
  const m = [{ file: 'a.ts', line: 1, until: '2020-01-01', reason: '이관 전까지' }]
  const live = await runScan(HYBRID(m), s, {}, new Date('2019-06-01T00:00:00Z'))
  assert.equal(live.candidates.length, 0)
  assert.equal(live.expired.length, 0)

  const dead = await runScan(HYBRID(m), s, {}, new Date('2020-06-01T00:00:00Z'))
  assert.equal(dead.candidates.length, 1, '만료된 면제는 없는 면제다')
  assert.equal(dead.expired.length, 1, '조용히 되살리지 않고 왜 돌아왔는지 남긴다')
  assert.equal(isExpired(m[0], new Date('2020-01-01T12:00:00Z')), false, '당일은 아직 살아 있다')
})

test('파싱되지 않는 until 은 등록에서 거부된다', () => {
  // 자유 텍스트 기한은 아무도 못 지킨다 — 영구 면제가 기한을 단 척한다.
  assert.throws(
    () => HYBRID([{ file: 'a.ts', until: '다음 스프린트', reason: 'r' }]),
    (e) => e instanceof RuleDefinitionError && /until/.test(e.message),
  )
  assert.throws(
    () => HYBRID([{ file: 'a.ts' }]),
    (e) => /reason/.test(e.message),
  )
})

test('레포 면제 파일은 룰 위에 얹히고 지문을 바꾼다', () => {
  const r = HYBRID()
  const [merged] = applyMaskFile([r], { h: [{ file: 'a.ts', line: 1, reason: '레포 결정' }] })
  assert.equal(merged.mask.length, 1)
  // 지문이 안 바뀌면 캐시가 옛 판정을 그대로 재생해 새 면제가 다음 실행까지 안 먹는다.
  assert.notEqual(merged.maskRev, r.maskRev)
  assert.equal(merged.maskRev, maskRev(merged.mask))
  assert.equal(stalenessOf(
    { criterionRev: r.criterionRev, scanRev: r.scanRev, maskRev: r.maskRev, subjectHash: 'h' },
    merged,
    { hash: 'h' },
  ).reason, 'mask-changed')
})

// --- 조건부 실행 ------------------------------------------------------------

const fixed = (files) => () => ({ label: 'fixed', files: Object.entries(files).map(([path, text]) => ({ path, text })) })

const runOne = (r, cwd) => run({ cwd, config: { store: '.gate' }, rules: [r] })

test('적용 대상이 아니면 통과가 아니라 미적용이다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-skip-'))
  const r = rule('mig', {
    criterion: '마이그레이션에는 롤백이 있다',
    subject: fixed({ 'src/a.ts': 'x' }),
    detect: /rollback/,
    skip: (s) => (s.files.some((f) => f.path.endsWith('.sql')) ? false : '이번 변경에 .sql 이 없다'),
  })
  const out = await runOne(r, dir)
  const v = out.verdicts[0]
  // 조용한 초록이면 커버리지가 있는 척한다 — 커널은 "대상 없음" 과 "대상이 지워짐" 을 구별 못 한다.
  assert.equal(v.state, 'skipped')
  assert.equal(v.reason, '이번 변경에 .sql 이 없다')
  assert.equal(out.verdicts.filter((x) => x.state === 'green').length, 0)
  assert.equal(out.outcome, 'pass')
})

test('사유 없는 건너뛰기는 broken 이다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-skip2-'))
  const r = rule('mig', {
    criterion: 'c',
    subject: fixed({ 'a.ts': 'x' }),
    detect: /zzz/,
    skip: () => true,
  })
  const out = await runOne(r, dir)
  assert.equal(out.verdicts[0].state, 'broken')
})

test('skip 이 바뀌면 과거 판정은 stale 이다', () => {
  const base = { criterion: 'c', detect: /x/ }
  const r1 = rule('s', { ...base, skip: () => false })
  const r2 = rule('s', { ...base, skip: () => '건너뜀' })
  assert.notEqual(r1.scanRev, r2.scanRev)
})

// --- 심각도 상한 ------------------------------------------------------------

test('판정 레인도 룰의 심각도 상한을 넘지 못한다', async () => {
  const r = rule('cap', {
    criterion: 'c',
    severity: 'critical',
    severityCap: 'low',
    scan: (ctx) => ({
      findings: [],
      candidates: [ctx.candidate('call', 'c1', 'm', [{ file: 'a.ts', line: 1 }])],
    }),
    // 축이 자기 상한을 더 느슨하게 적어도 룰의 상한이 이긴다.
    judge: { ask: 'q', because: 'b', cap: 'critical' },
  })
  const s = slice({ 'a.ts': 'x' })
  const scan = await runScan(r, s, {})
  const req = buildRequest(r, s, scan.candidates, { deadlineSeconds: 1, sliceChars: 100, round: 1 })
  assert.equal(req.cap, 'low')
  const [f] = ingest(req, {
    rule: 'cap',
    key: req.key,
    round: 1,
    decisions: [{ code: 'cap.c1', violates: true, why: 'a.ts:1 이 어긋난다' }],
  })
  // 등급은 레지스트리가 정한다 — 판정자가 자기 판정의 등급을 스스로 올리지 못한다.
  assert.equal(f.severity, 'low')
})

test('후보를 하나라도 빼먹은 응답은 통과가 아니라 계약 위반이다', async () => {
  const s = slice({ 'a.ts': 'x', 'b.ts': 'y' })
  const scan = await runScan(HYBRID(), s, {})
  const req = buildRequest(HYBRID(), s, scan.candidates, { deadlineSeconds: 1, sliceChars: 200, round: 1 })
  assert.throws(
    () => ingest(req, { rule: 'h', key: req.key, round: 1, decisions: [{ code: req.candidates[0].code, violates: false, why: 'ok' }] }),
    (e) => /미판정/.test(e.message),
  )
})

test('기한이 지나기만 해도 캐시된 판정은 stale 이다', () => {
  // 내용은 아무것도 안 바뀌므로 maskRev 는 그대로다 — 시간만 흐른다.
  // 이 축이 없으면 마스크가 살아 있을 때 저장된 green 이 만료 후에도 재생돼
  // `until` 이 사실상 영구 면제가 된다.
  const r = HYBRID([{ file: 'a.ts', line: 1, until: '2025-01-31', reason: '이관 전까지' }])
  const prev = {
    criterionRev: r.criterionRev,
    scanRev: r.scanRev,
    maskRev: r.maskRev,
    subjectHash: 'h',
    at: '2025-01-10T00:00:00.000Z',
  }
  assert.equal(stalenessOf(prev, r, { hash: 'h' }, new Date('2025-01-20T00:00:00Z')).fresh, true)
  assert.equal(stalenessOf(prev, r, { hash: 'h' }, new Date('2025-02-01T00:00:00Z')).reason, 'mask-expired')
  // 이미 만료된 뒤에 낸 판정은 그 사실을 반영하고 있으니 다시 무효화하지 않는다.
  const after = { ...prev, at: '2025-03-01T00:00:00.000Z' }
  assert.equal(stalenessOf(after, r, { hash: 'h' }, new Date('2025-03-02T00:00:00Z')).fresh, true)
})
