import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(import.meta.dirname, '..')
const CLI = join(ROOT, 'dist', 'cli.js')
const ANSI = /\x1b\[[0-9;]*m/g

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-cli-'))
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  symlinkSync(ROOT, join(dir, 'node_modules', 'gate-kernel'), 'dir')
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true })
    writeFileSync(join(dir, p), text)
  }
  return dir
}

function gate(dir, args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: undefined, ...env },
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

const CONFIG = (extra = '') => `import { defineConfig, subject } from 'gate-kernel';
export default defineConfig({ rules: ['gates/*.rule.mjs'], store: '.gate', subject: subject.tree('subject.txt')${extra} });`
const UNPROVEN = `import { rule } from 'gate-kernel';
export default rule('example', { criterion: 'Reject BAD content.', detect: /BAD/ });`
const PROVEN = `import { rule } from 'gate-kernel';
export default rule('primary', { criterion: 'Reject BAD content.', detect: /BAD/,
  prove: [{ name: 'red', files: { 'subject.txt': 'BAD' }, expect: 'red' }, { name: 'green', files: { 'subject.txt': 'GOOD' }, expect: 'green' }] });`

// --- #3: 빈 선택 · unproven 은 exit 0 이 아니다 ---------------------------------

test('룰 0개: prove/run/status 모두 3 이고 JSON 도 blocked 라고 말한다', () => {
  const dir = project({ 'gate.config.mjs': CONFIG(), 'subject.txt': 'GOOD\n' })
  mkdirSync(join(dir, 'gates'))
  const p = gate(dir, ['prove', '--json'])
  assert.equal(p.code, 3); assert.deepEqual(JSON.parse(p.out), []); assert.match(p.err, /0개/)
  const r = gate(dir, ['run', '--json'])
  assert.equal(r.code, 3)
  const body = JSON.parse(r.out)
  assert.equal(body.outcome, 'blocked'); assert.deepEqual(body.coverage.gaps, ['empty-selection'])
  assert.match(gate(dir, ['run']).out, /outcome: blocked/)
  assert.equal(gate(dir, ['status', '--json']).code, 3)
})

test('룰 0개 + allowEmpty: pass/0 이지만 검사한 것이 없다고 말한다', () => {
  const dir = project({ 'gate.config.mjs': CONFIG(', coverage: { allowEmpty: true }'), 'subject.txt': 'GOOD\n' })
  mkdirSync(join(dir, 'gates'))
  assert.equal(gate(dir, ['prove', '--json']).code, 0)
  const r = gate(dir, ['run'])
  assert.equal(r.code, 0); assert.match(r.out, /allowEmpty/); assert.match(r.out, /outcome: pass/)
})

test('unproven 룰 1개: run 은 blocked/3, status 도 3, prove 로 시연하면 green/0', () => {
  const dir = project({ 'gate.config.mjs': CONFIG(), 'subject.txt': 'GOOD\n', 'gates/example.rule.mjs': UNPROVEN })
  const r = gate(dir, ['run', '--json'])
  assert.equal(r.code, 3)
  const body = JSON.parse(r.out)
  assert.equal(body.verdicts[0].state, 'unproven'); assert.equal(body.outcome, 'blocked')
  assert.match(gate(dir, ['run']).out, /red 를 시연해라/)
  assert.equal(gate(dir, ['status']).code, 3)
  assert.equal(gate(dir, ['prove']).code, 1, '픽스처 없는 룰은 prove 도 실패다')

  writeFileSync(join(dir, 'gates/example.rule.mjs'), PROVEN.replace("'primary'", "'example'"))
  assert.equal(gate(dir, ['prove']).code, 0)
  const ok = gate(dir, ['run', '--json'])
  assert.equal(ok.code, 0); assert.equal(JSON.parse(ok.out).outcome, 'pass')
  assert.equal(gate(dir, ['status']).code, 0)
})

test('requireProven: false 는 통과시키되 매 실행 경고한다', () => {
  const dir = project({ 'gate.config.mjs': CONFIG(', coverage: { requireProven: false }'), 'subject.txt': 'GOOD\n', 'gates/example.rule.mjs': UNPROVEN })
  const r = gate(dir, ['run'])
  assert.equal(r.code, 0); assert.match(r.out, /requireProven/); assert.match(r.out, /outcome: pass/)
})

// --- #4: 선언된 룰이 사라지면 어떤 명령도 그 위에서 돌지 않는다 ------------------

test('리터럴 경로 누락: list/prove/run 전부 3 이고 경로를 말한다', () => {
  const dir = project({
    'gate.config.mjs': `import { defineConfig } from 'gate-kernel';
export default defineConfig({ rules: ['gates/primary.rule.mjs', 'gates/secondary.rule.mjs'], store: '.gate' });`,
    'subject.txt': 'GOOD\n',
    'gates/primary.rule.mjs': PROVEN,
  })
  for (const cmd of ['list', 'prove', 'run']) {
    const r = gate(dir, [cmd, '--json'])
    assert.equal(r.code, 3, cmd); assert.match(r.err, /gates\/secondary\.rule\.mjs: 파일이 없다/)
  }
  writeFileSync(join(dir, 'gates/secondary.rule.mjs'), 'export const unrelated = true;')
  assert.match(gate(dir, ['run']).err, /export 가 없다/)
})

test('required id 누락은 3, 충족하면 정상', () => {
  const dir = project({
    'gate.config.mjs': CONFIG(", required: ['primary', 'secondary']"),
    'subject.txt': 'GOOD\n',
    'gates/primary.rule.mjs': PROVEN,
  })
  const r = gate(dir, ['run'])
  assert.equal(r.code, 3); assert.match(r.err, /룰 id secondary/)
  writeFileSync(join(dir, 'gate.config.mjs'), CONFIG(", required: ['primary']"))
  gate(dir, ['prove'])
  assert.equal(gate(dir, ['run']).code, 0)
})

test('스위트 required 가 선택에 없으면 run 은 3, list 는 진단용으로 돈다', () => {
  const dir = project({
    'gate.config.mjs': CONFIG(", suites: { docs: { include: ['docs/**'], required: ['primary'] } }"),
    'subject.txt': 'GOOD\n',
    'gates/primary.rule.mjs': PROVEN.replace("detect: /BAD/,", "detect: /BAD/, tags: ['code/x'],"),
  })
  const r = gate(dir, ['run', 'docs'])
  assert.equal(r.code, 3); assert.match(r.err, /요구한 룰이 선택에 없다: primary/)
  assert.equal(gate(dir, ['list', 'docs']).code, 0)
  gate(dir, ['prove'])
  assert.equal(gate(dir, ['run', '--rule', 'primary']).code, 0, '--rule 은 의도된 부분 실행이라 스위트 required 를 묻지 않는다')
})

// --- #2: 색은 표현 계층이고 JSON 은 언제나 깨끗하다 ------------------------------

test('--color / NO_COLOR / --format 우선순위와 JSON 무오염', () => {
  const dir = project({ 'gate.config.mjs': CONFIG(), 'subject.txt': 'GOOD\n', 'gates/primary.rule.mjs': PROVEN })
  gate(dir, ['prove'])
  const count = (s) => (s.match(ANSI) ?? []).length

  const always = gate(dir, ['run', '--verbose', '--color', 'always'])
  assert.ok(count(always.out) > 0); assert.match(always.out, /\x1b\[32m/)
  assert.equal(count(gate(dir, ['run', '--verbose', '--color', 'never']).out), 0)
  assert.equal(count(gate(dir, ['run', '--verbose']).out), 0, '파이프(non-TTY) auto 는 색이 없다')
  assert.equal(count(gate(dir, ['run', '--verbose', '--color', 'auto'], { NO_COLOR: '1' }).out), 0)
  assert.ok(count(gate(dir, ['run', '--verbose', '--color', 'always'], { NO_COLOR: '1' }).out) > 0, '명시 플래그가 NO_COLOR 를 이긴다')
  assert.ok(count(gate(dir, ['run', '--verbose', '--format', 'pretty']).out) > 0, 'pretty = instruct + 색 강제')
  assert.equal(count(gate(dir, ['run', '--verbose', '--format', 'pretty', '--color', 'never']).out), 0)

  for (const args of [['run', '--json', '--color', 'always'], ['run', '--format', 'json', '--color', 'always'], ['status', '--json', '--color', 'always'], ['prove', '--json', '--color', 'always'], ['list', '--json', '--color', 'always']]) {
    const r = gate(dir, args)
    assert.equal(count(r.out), 0, args.join(' '))
    assert.doesNotThrow(() => JSON.parse(r.out), args.join(' '))
  }
  // 종료 코드는 포맷과 무관하다.
  assert.equal(gate(dir, ['run', '--json']).code, gate(dir, ['run', '--format', 'pretty']).code)
  assert.equal(gate(dir, ['run', '--color', 'maybe']).code, 2)
  assert.equal(gate(dir, ['run', '--format', 'xml']).code, 2)

  // status/prove/list 도 같은 렌더러를 쓴다.
  const st = gate(dir, ['status', '--color', 'always'])
  assert.match(st.out, /\x1b\[32m✓\x1b\[39m \x1b\[32mgreen/)
  assert.match(gate(dir, ['status']).out, /^✓ green {5}primary$/m)
  assert.match(gate(dir, ['prove', '--color', 'always']).out, /\x1b\[32m✓\x1b\[39m primary/)
  assert.match(gate(dir, ['list', '--color', 'always']).out, /\x1b\[1mprimary\x1b\[22m/)
})

test('config output.format / output.color 가 실제로 적용되고 플래그가 그 위를 덮는다', () => {
  const dir = project({ 'gate.config.mjs': CONFIG(", output: { format: 'json', color: 'always' }"), 'subject.txt': 'GOOD\n', 'gates/primary.rule.mjs': PROVEN })
  gate(dir, ['prove'])
  assert.doesNotThrow(() => JSON.parse(gate(dir, ['run']).out), 'output.format: json 이 기본 출력이 된다')
  const inst = gate(dir, ['run', '--format', 'instruct', '--verbose'])
  assert.ok((inst.out.match(ANSI) ?? []).length > 0, 'output.color: always 가 non-TTY 에서도 색을 켠다')
  assert.equal((gate(dir, ['run', '--format', 'instruct', '--color', 'never']).out.match(ANSI) ?? []).length, 0)
})
