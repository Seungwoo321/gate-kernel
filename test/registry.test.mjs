import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { loadRules, loadConfig, RuleRegistryError, isLiteralPath } from '../dist/runtime.js'

const ROOT = resolve(import.meta.dirname, '..')

/** 소비자 프로젝트처럼 `gate-kernel` 을 node_modules 에서 찾게 만든다. */
function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-reg-'))
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  symlinkSync(ROOT, join(dir, 'node_modules', 'gate-kernel'), 'dir')
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true })
    writeFileSync(join(dir, p), text)
  }
  return dir
}

const PRIMARY = `import { rule } from 'gate-kernel';
export default rule('primary', { criterion: 'Reject BAD.', detect: /BAD/,
  prove: [{ name: 'r', files: { 'a.txt': 'BAD' }, expect: 'red' }] });`

test('리터럴 경로와 글롭을 구별한다', () => {
  assert.equal(isLiteralPath('gates/a.rule.mjs'), true)
  assert.equal(isLiteralPath('gates/*.rule.mjs'), false)
  assert.equal(isLiteralPath('gates/**/x.rule.{mjs,js}'), false)
  assert.equal(isLiteralPath('gates/a?.rule.mjs'), false)
  assert.equal(isLiteralPath('gates/[ab].rule.mjs'), false)
})

test('리터럴 경로가 없으면 등록을 거부한다 — 남은 룰로 통과를 내지 않는다 (#4)', async () => {
  const dir = project({ 'gates/primary.rule.mjs': PRIMARY })
  await assert.rejects(
    () => loadRules(dir, { rules: ['gates/primary.rule.mjs', 'gates/secondary.rule.mjs'] }),
    (e) => e instanceof RuleRegistryError && e.missing.length === 1 && e.missing[0].kind === 'path' && e.missing[0].ref === 'gates/secondary.rule.mjs' && /파일이 없다/.test(e.message),
  )
})

test('리터럴 경로의 파일은 있는데 rule() export 가 없어도 거부한다 (#4)', async () => {
  const dir = project({ 'gates/primary.rule.mjs': PRIMARY, 'gates/secondary.rule.mjs': 'export const unrelated = true;' })
  await assert.rejects(
    () => loadRules(dir, { rules: ['gates/primary.rule.mjs', 'gates/secondary.rule.mjs'] }),
    (e) => e instanceof RuleRegistryError && /export 가 없다/.test(e.message),
  )
})

test('글롭은 질의라 아무것도 안 걸려도 오류가 아니다', async () => {
  const dir = project({ 'gates/primary.rule.mjs': PRIMARY })
  const rules = await loadRules(dir, { rules: ['gates/*.rule.mjs', 'extra/**/*.rule.mjs'] })
  assert.deepEqual(rules.map((r) => r.id), ['primary'])
})

test('required 는 파일이 아니라 id 로 검사한다 — 다른 id 로 바뀐 파일은 개수를 채워도 안 된다 (#4)', async () => {
  const dir = project({
    'gates/primary.rule.mjs': PRIMARY,
    'gates/secondary.rule.mjs': PRIMARY.replace("'primary'", "'other'"),
  })
  await assert.rejects(
    () => loadRules(dir, { rules: ['gates/*.rule.mjs'], required: ['primary', 'secondary'] }),
    (e) => e instanceof RuleRegistryError && e.missing.length === 1 && e.missing[0].kind === 'id' && e.missing[0].ref === 'secondary',
  )
  const ok = await loadRules(dir, { rules: ['gates/*.rule.mjs'], required: ['primary', 'other'] })
  assert.deepEqual(ok.map((r) => r.id).sort(), ['other', 'primary'])
})

test('한 번 통과한 뒤 필수 룰이 지워지면 다음 로드가 거부된다 (#4)', async () => {
  const dir = project({ 'gates/primary.rule.mjs': PRIMARY, 'gates/secondary.rule.mjs': PRIMARY.replace("'primary'", "'secondary'") })
  const cfg = { rules: ['gates/*.rule.mjs'], required: ['primary', 'secondary'] }
  assert.equal((await loadRules(dir, cfg)).length, 2)
  rmSync(join(dir, 'gates/secondary.rule.mjs'))
  await assert.rejects(() => loadRules(dir, cfg, { reload: true }), RuleRegistryError)
})

test('gate.config 의 required 가 loadConfig 를 거쳐 그대로 전달된다', async () => {
  const dir = project({
    'gate.config.mjs': `export default { rules: ['gates/*.rule.mjs'], required: ['primary'] }`,
    'gates/primary.rule.mjs': PRIMARY,
  })
  const cfg = await loadConfig(dir)
  assert.deepEqual(cfg.required, ['primary'])
  assert.equal((await loadRules(dir, cfg)).length, 1)
})
