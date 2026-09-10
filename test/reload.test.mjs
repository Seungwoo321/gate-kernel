import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { loadConfig, loadRules, run, StaleModuleGraphError } from '../dist/runtime.js'
import { isRuleSpec } from '../dist/index.js'

const ROOT = resolve(import.meta.dirname, '..')

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'gate-reload-'))
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  mkdirSync(join(dir, 'gates'))
  symlinkSync(ROOT, join(dir, 'node_modules', 'gate-kernel'), 'dir')
  const put = (p, text) => writeFileSync(join(dir, p), text)
  return { dir, put }
}

const configSource = (include) => `export default {
  rules: ['gates/*.rule.mjs'],
  subject: () => ({ label: 'fixed', files: [{ path: 'subject.txt', text: 'NEW' }] }),
  suites: { release: { include: ${JSON.stringify(include)} } },
};`
const ruleSource = (expression) => `import { rule } from 'gate-kernel';
import { pattern } from '../checker.mjs';
export default rule('example', { criterion: 'Reject matched content.', detect: ${expression},
  prove: [{ name: 'r', files: { 'a.txt': 'BAD' }, expect: 'red' }] });`

test('reload 없이 다시 로드하면 옛 모듈이 돌아오고, 엔트리 바이트가 바뀌면 StaleModuleGraphError 다 (#5)', async () => {
  const { dir, put } = project()
  put('gate.config.mjs', configSource(['release/**']))
  put('checker.mjs', 'export const pattern = /BAD/;')
  put('gates/example.rule.mjs', ruleSource('pattern'))

  const cfg1 = await loadConfig(dir)
  const [r1] = await loadRules(dir, cfg1)
  assert.equal(String(r1.detect), '/BAD/')

  // 전이 헬퍼만 바뀌면 엔트리 지문은 그대로라 가드는 못 잡는다 — 그래서 reload 가 있다.
  put('checker.mjs', 'export const pattern = /BAD|NEW/;')
  const [r2] = await loadRules(dir, cfg1)
  assert.equal(String(r2.detect), '/BAD/', 'Node 모듈 캐시: 재로드 없이는 옛 바이트다')

  // 엔트리(룰 파일) 자체가 바뀌면 조용히 옛것을 주지 않고 던진다.
  put('gates/example.rule.mjs', ruleSource('/CHANGED/'))
  await assert.rejects(() => loadRules(dir, cfg1), (e) => e instanceof StaleModuleGraphError && e.changed.length === 1)
})

test('reload: true 는 설정·룰·전이 헬퍼를 전부 새 세대로 본다 (#5)', async () => {
  const { dir, put } = project()
  put('gate.config.mjs', configSource(['release/**']))
  put('checker.mjs', 'export const pattern = /BAD/;')
  put('gates/example.rule.mjs', ruleSource('pattern'))

  const read = async (opts) => {
    const cfg = await loadConfig(dir, opts)
    const [r] = await loadRules(dir, cfg, opts)
    return { detect: String(r.detect), include: cfg.suites.release.include, rule: r }
  }
  assert.equal((await read()).detect, '/BAD/')

  put('checker.mjs', 'export const pattern = /BAD|NEW/;')
  assert.equal((await read({ reload: true })).detect, '/BAD|NEW/', '전이 헬퍼 변경')

  put('gates/example.rule.mjs', ruleSource('/BAD|NEW|RULE/'))
  assert.equal((await read({ reload: true })).detect, '/BAD|NEW|RULE/', '룰 엔트리 변경')

  put('gate.config.mjs', configSource(['docs/**']))
  assert.deepEqual((await read({ reload: true })).include, ['docs/**'], '설정 변경')

  // 같은 세대 id 는 같은 그래프를 재사용한다.
  put('checker.mjs', 'export const pattern = /SHOULD-NOT-SEE/;')
  const a = await read({ generation: 'pinned' })
  put('checker.mjs', 'export const pattern = /STILL-NOT/;')
  const b = await read({ generation: 'pinned' })
  assert.equal(a.detect, b.detect)
  assert.notEqual(a.detect, '/STILL-NOT/')

  // node_modules 의 gate-kernel 은 세대와 무관하게 단일 인스턴스다.
  assert.equal(isRuleSpec((await read({ reload: true })).rule), true)
})

test('fresh 는 판정 캐시를, reload 는 모듈 그래프를 새로 한다 — 다른 보증이다 (#5)', async () => {
  const { dir, put } = project()
  put('gate.config.mjs', configSource(['release/**']))
  put('checker.mjs', 'export const pattern = /BAD/;')
  put('gates/example.rule.mjs', ruleSource('pattern'))

  const cfg = await loadConfig(dir)
  const rules = await loadRules(dir, cfg)
  const first = await run({ cwd: dir, config: cfg, rules })
  assert.equal(first.verdicts[0].findings.length, 0, 'subject 가 NEW 뿐이라 /BAD/ 로는 결함 0')
  assert.equal(first.verdicts[0].state, 'unproven', 'prove 를 돌리지 않았으니 red 미시연')
  assert.equal(first.outcome, 'blocked')

  // 탐지식이 NEW 를 잡도록 바뀌었다. 옛 그래프 + fresh 는 여전히 결함 0 이다.
  put('checker.mjs', 'export const pattern = /BAD|NEW/;')
  const stale = await run({ cwd: dir, config: cfg, rules, fresh: true })
  assert.equal(stale.verdicts[0].findings.length, 0, 'fresh 는 판정 캐시만 우회한다')
  assert.equal(stale.verdicts[0].cacheHit, false)

  const cfg2 = await loadConfig(dir, { reload: true })
  const rules2 = await loadRules(dir, cfg2, { reload: true })
  const current = await run({ cwd: dir, config: cfg2, rules: rules2, fresh: true })
  assert.equal(current.verdicts[0].state, 'red', 'reload 뒤에는 현재 바이트로 판정한다')
  assert.equal(current.outcome, 'fail')
})
