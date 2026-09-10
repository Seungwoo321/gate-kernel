import test from 'node:test'
import assert from 'node:assert/strict'

import { paint, resolveColor, stripAnsi, ANSI_RE, renderRun, renderStatus, renderProve, renderList, STATE_MARK } from '../dist/runtime.js'
import { rule } from '../dist/index.js'

const ansi = (s) => (s.match(ANSI_RE) ?? []).length

test('색 결정 순서: 플래그 > 설정 > NO_COLOR > TTY', () => {
  assert.equal(resolveColor({ isTTY: true }), true)
  assert.equal(resolveColor({ isTTY: false }), false)
  assert.equal(resolveColor({ isTTY: true, noColor: '1' }), false)
  assert.equal(resolveColor({ isTTY: true, noColor: '' }), true, '빈 NO_COLOR 는 설정 안 된 것과 같다(no-color.org)')
  assert.equal(resolveColor({ isTTY: false, config: 'always' }), true)
  assert.equal(resolveColor({ isTTY: true, config: 'never' }), false)
  assert.equal(resolveColor({ isTTY: false, noColor: '1', flag: 'always' }), true, '명시 플래그가 환경을 이긴다')
  assert.equal(resolveColor({ isTTY: true, config: 'always', flag: 'never' }), false)
  assert.equal(resolveColor({ isTTY: false, config: 'auto', flag: 'auto' }), false)
})

test('paint 는 켜졌을 때만 SGR 을 붙이고, 벗기면 원문이 남는다', () => {
  const on = paint(true), off = paint(false)
  assert.match(on.green('x'), /^\x1b\[32mx\x1b\[39m$/)
  assert.match(on.red('x'), /^\x1b\[31m/)
  assert.equal(off.green('x'), 'x')
  assert.equal(stripAnsi(on.bold(on.red('ab'))), 'ab')
})

const now = new Date().toISOString()
const v = (id, state, findings = []) => ({
  rule: id, state, findings, key: 'k', criterionRev: 'c', scanRev: 's', maskRev: 'm', subjectHash: 'h', lane: 'deterministic', at: now,
})
const result = (verdicts, outcome, gaps = []) => ({
  verdicts, outcome, counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, unjudged: [], pending: [], expired: [],
  coverage: { selected: verdicts.length, executed: verdicts.length, green: verdicts.filter((x) => x.state === 'green').length, unproven: verdicts.filter((x) => x.state === 'unproven').map((x) => x.rule), skipped: [], gaps },
  startedAt: now, finishedAt: now,
})
const rules = [rule('a', { criterion: 'A', detect: /x/ }), rule('b', { criterion: 'B', detect: /y/ })]
const opts = (color) => ({ cwd: '/p', storeDir: '/p/.gate', verbose: true, color })

test('renderRun: 색을 끄면 SGR 이 0건이고, 켜면 초록/빨강이 실제 SGR 로 나온다', () => {
  const f = { rule: 'b', code: 'b.x', severity: 'high', message: 'm', locations: [{ file: 'f', line: 1 }], foundBy: 'scan' }
  const r = result([v('a', 'green'), v('b', 'red', [f])], 'fail')
  const plain = renderRun(r, rules, opts(false))
  assert.equal(ansi(plain), 0)
  const colored = renderRun(r, rules, opts(true))
  assert.ok(ansi(colored) > 0)
  assert.match(colored, /\x1b\[32m/, 'green')
  assert.match(colored, /\x1b\[31m/, 'red')
  assert.equal(stripAnsi(colored), plain, '색은 표현 계층이다 — 벗기면 같은 문서다')
})

test('renderRun: 같은 결과는 색 여부와 무관하게 같은 outcome 문장을 낸다', () => {
  for (const [state, outcome, gaps] of [['green', 'pass', []], ['unproven', 'blocked', ['unproven']]]) {
    const r = result([v('a', state)], outcome, gaps)
    const plain = renderRun(r, rules, opts(false))
    const colored = stripAnsi(renderRun(r, rules, opts(true)))
    assert.equal(plain, colored)
    assert.match(plain, new RegExp(`outcome: ${outcome}`))
  }
})

test('renderRun: 막는 unproven 은 할 일이고, requireProven 이 꺼지면 참고다', () => {
  const blocking = renderRun(result([v('a', 'unproven')], 'blocked', ['unproven']), rules, opts(false))
  assert.match(blocking, /red 를 시연해라/)
  assert.match(blocking, /outcome: blocked/)
  const advisory = renderRun(result([v('a', 'unproven')], 'pass', []), rules, opts(false))
  assert.doesNotMatch(advisory, /지금 할 일/)
  assert.match(advisory, /requireProven/)
  assert.match(advisory, /outcome: pass/)
})

test('renderRun: 빈 선택은 갭이면 blocked, allowEmpty 면 pass 라고 말한다', () => {
  const empty = (gaps, outcome) => ({ ...result([], outcome, gaps), coverage: { selected: 0, executed: 0, green: 0, unproven: [], skipped: [], gaps } })
  assert.match(renderRun(empty(['empty-selection'], 'blocked'), [], opts(false)), /0개다[\s\S]*outcome: blocked/)
  assert.match(renderRun(empty([], 'pass'), [], opts(false)), /allowEmpty[\s\S]*outcome: pass/)
})

test('renderStatus / renderProve / renderList 도 같은 색 계층을 쓴다', () => {
  const rows = [
    { id: 'a', lane: 'deterministic', state: 'green', provenRed: true, findings: 0, criterion: 'A' },
    { id: 'b', lane: 'hybrid', state: 'red', provenRed: true, findings: 2, criterion: 'B' },
    { id: 'c', lane: 'deterministic', state: 'unproven', provenRed: false, findings: 0, criterion: 'C' },
  ]
  const plain = renderStatus(rows)
  assert.equal(ansi(plain), 0)
  assert.match(plain, /^✓ green {5}a$/m)
  assert.match(plain, /^\? unproven {2}c$/m)
  const colored = renderStatus(rows, { color: true })
  assert.match(colored, /\x1b\[32m✓/)
  assert.match(colored, /\x1b\[31m✗/)
  assert.equal(stripAnsi(colored), plain)

  const proves = [{ rule: 'a', cases: [], demonstratesRed: false, ok: false }, { rule: 'b', cases: [{ name: 'n', expect: 'red', got: 'green', ok: false }], demonstratesRed: true, ok: false }]
  assert.match(renderProve(proves), /✗ a {2}\(red 미시연 — unproven\)/)
  assert.match(renderProve(proves), /✗ n: red 기대, green 나옴/)
  assert.match(renderProve(proves, { lang: 'en' }), /no red demonstrated/)
  assert.ok(ansi(renderProve(proves, { color: true })) > 0)

  assert.match(renderList(rules), /● a\n {4}A\n/)
  assert.equal(stripAnsi(renderList(rules, { color: true })), renderList(rules))
  assert.deepEqual(Object.keys(STATE_MARK).sort(), ['broken', 'green', 'red', 'skipped', 'stale', 'unproven'])
})
