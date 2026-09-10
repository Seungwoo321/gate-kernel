import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { rule, resolveConfig } from '../dist/index.js'
import { aggregate, run, resolveSuite, selectRules } from '../dist/runtime.js'
import { markProvenRed } from '../dist/store/verdicts.js'

// --- 집계는 관측된 판정 밖에서 "몇 개를 돌리기로 했는가" 를 받아야 한다 -------------

const now = new Date().toISOString()
const verdict = (rule, state, findings = []) => ({
  rule, state, findings, key: 'k', criterionRev: 'c', scanRev: 's', maskRev: 'm', subjectHash: 'h', lane: 'deterministic', at: now,
})

test('unproven 이 하나라도 있으면 outcome 은 pass 가 아니라 blocked 다 (#3)', () => {
  const out = aggregate([verdict('a', 'unproven')], 'high', [], now, { selected: 1 })
  assert.equal(out.outcome, 'blocked')
  assert.deepEqual(out.coverage.gaps, ['unproven'])
  assert.deepEqual(out.coverage.unproven, ['a'])
  assert.equal(out.coverage.green, 0)
})

test('고른 룰이 0개면 blocked 다 — 빈 배열의 every 는 참이지만 증명은 아니다 (#3)', () => {
  const out = aggregate([], 'high', [], now, { selected: 0 })
  assert.equal(out.outcome, 'blocked')
  assert.deepEqual(out.coverage.gaps, ['empty-selection'])
  assert.equal(out.coverage.selected, 0)
})

test('allowEmpty 는 빈 선택을 명시적으로 허용한다', () => {
  const out = aggregate([], 'high', [], now, { selected: 0, allowEmpty: true })
  assert.equal(out.outcome, 'pass')
  assert.deepEqual(out.coverage.gaps, [])
})

test('requireProven 을 끄면 unproven 이 통과로 접힌다 — 탈출구이지 기본이 아니다', () => {
  const out = aggregate([verdict('a', 'unproven')], 'high', [], now, { selected: 1, requireProven: false })
  assert.equal(out.outcome, 'pass')
  assert.deepEqual(out.coverage.unproven, ['a'], '접혀도 목록에는 남는다 — 리포트가 경고한다')
  assert.deepEqual(out.coverage.gaps, [])
})

test('green 만 있으면 pass 이고 커버리지 숫자가 맞는다', () => {
  const out = aggregate([verdict('a', 'green'), verdict('b', 'green')], 'high', [], now, { selected: 2 })
  assert.equal(out.outcome, 'pass')
  assert.deepEqual(out.coverage, { selected: 2, executed: 2, green: 2, unproven: [], skipped: [], gaps: [] })
})

test('red 는 unproven 보다 앞선다 — fail 이 blocked 를 가린다', () => {
  const f = { rule: 'a', code: 'a.x', severity: 'high', message: 'm', locations: [{ file: 'a', line: 1 }], foundBy: 'scan' }
  const out = aggregate([verdict('a', 'red', [f]), verdict('b', 'unproven')], 'high', [], now, { selected: 2 })
  assert.equal(out.outcome, 'fail')
  assert.deepEqual(out.coverage.gaps, ['unproven'], '가려져도 갭은 기록된다')
})

test('전부 skipped 는 갭이 아니라 executed 0 으로 드러난다', () => {
  const out = aggregate([verdict('a', 'skipped'), verdict('b', 'skipped')], 'high', [], now, { selected: 2 })
  assert.equal(out.outcome, 'pass')
  assert.equal(out.coverage.executed, 0)
  assert.deepEqual(out.coverage.skipped, ['a', 'b'])
  assert.deepEqual(out.coverage.gaps, [])
})

test('커버리지 입력을 생략한 옛 호출자도 unproven 은 막힌다', () => {
  const out = aggregate([verdict('a', 'unproven')], 'high', [], now)
  assert.equal(out.outcome, 'blocked')
  assert.equal(out.coverage.selected, 1)
})

// --- run() 이 실제로 커버리지를 채운다 -----------------------------------------

const fixed = (files) => () => ({ label: 'fixed', files: Object.entries(files).map(([path, text]) => ({ path, text })) })

test('run: red 를 시연한 적 없는 깨끗한 룰은 blocked/unproven 이다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-cov-'))
  const r = rule('clean', { criterion: 'c', subject: fixed({ 'a.txt': 'GOOD' }), detect: /BAD/ })
  const out = await run({ cwd: dir, config: { store: '.gate' }, rules: [r] })
  assert.equal(out.verdicts[0].state, 'unproven')
  assert.equal(out.outcome, 'blocked')
  assert.deepEqual(out.coverage.gaps, ['unproven'])
})

test('run: prove 로 red 를 시연하고 나면 같은 룰이 green/pass 가 된다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-cov2-'))
  const r = rule('clean', { criterion: 'c', subject: fixed({ 'a.txt': 'GOOD' }), detect: /BAD/ })
  markProvenRed(join(dir, '.gate'), 'clean', 'prove')
  const out = await run({ cwd: dir, config: { store: '.gate' }, rules: [r] })
  assert.equal(out.verdicts[0].state, 'green')
  assert.equal(out.outcome, 'pass')
  assert.equal(out.coverage.green, 1)
})

test('run: 룰 0개는 blocked, config.coverage.allowEmpty 면 pass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-cov3-'))
  const blocked = await run({ cwd: dir, config: { store: '.gate' }, rules: [] })
  assert.equal(blocked.outcome, 'blocked')
  const allowed = await run({ cwd: dir, config: { store: '.gate', coverage: { allowEmpty: true } }, rules: [] })
  assert.equal(allowed.outcome, 'pass')
})

test('run: --rule 이 아무것도 못 고르면 selected 0 → blocked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-cov4-'))
  const r = rule('clean', { criterion: 'c', subject: fixed({ 'a.txt': 'x' }), detect: /BAD/ })
  const out = await run({ cwd: dir, config: { store: '.gate' }, rules: [r], only: ['typo'] })
  assert.equal(out.coverage.selected, 0)
  assert.equal(out.outcome, 'blocked')
})

// --- 스위트의 required 는 선택에 대한 요구다 (#4) ------------------------------

test('스위트 required 가 선택에 없으면 missing 에 남는다', () => {
  const cfg = resolveConfig({
    suites: { release: { include: ['docs/**'], required: ['api-sync', 'ghost'] } },
  })
  const rules = [
    { id: 'term', tags: ['docs/terminology'] },
    { id: 'api-sync', tags: ['docs/api'] },
    { id: 'layer', tags: ['code/layering'] },
  ]
  const sel = selectRules(rules, resolveSuite(cfg, 'release'))
  assert.deepEqual(sel.targets.map((r) => r.id), ['term', 'api-sync'])
  assert.deepEqual(sel.missing, ['ghost'])
})

test('스위트 required 는 extends 를 따라 합쳐지고, --rule 부분 실행에는 적용되지 않는다', () => {
  const cfg = resolveConfig({
    suites: {
      docs: { include: ['docs/**'], required: ['term'] },
      full: { extends: ['docs'], include: ['code/**'], required: ['layer'] },
    },
  })
  const full = resolveSuite(cfg, 'full')
  assert.deepEqual(full.required.sort(), ['layer', 'term'])
  const rules = [{ id: 'term', tags: ['docs/x'] }]
  assert.deepEqual(selectRules(rules, full).missing, ['layer'])
  assert.deepEqual(selectRules(rules, full, ['term']).missing, [], '--rule 은 의도된 부분 실행이다')
})

test('config.required 는 mergeConfig 에서 합집합이다', () => {
  const cfg = resolveConfig({ required: ['a'] })
  assert.deepEqual(cfg.required, ['a'])
  assert.deepEqual(cfg.coverage, { allowEmpty: false, requireProven: true })
  const suite = resolveSuite(resolveConfig({ suites: { s: { coverage: { allowEmpty: true } } } }), 's')
  assert.equal(suite.config.coverage.allowEmpty, true)
  assert.equal(suite.config.coverage.requireProven, true, '그룹은 얕게 합쳐져 나머지 기본값을 잃지 않는다')
})
