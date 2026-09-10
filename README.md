# gate-kernel

**규칙을 넣으면 게이트가 된다.**

코드 규칙을 넣으면 코드 게이트로 동작하고, 문서 정합 규칙을 넣으면 문서 정합 게이트로 동작한다.
게이트마다 러너·캐시·판정 계약·집계·리포트를 새로 짜지 않는다 — 그건 커널이 이미 갖고 있다.

테스트 프레임워크가 `test(name, fn)` 하나로 TDD 를 가능하게 만든 것과 같은 자리를,
LLM 이 만들고 LLM 이 판정하는 게이트에 대해 차지한다.

## 왜 필요한가

LLM 으로 만든 것을 검증하는 건 결국 게이트다. 그 게이트는 두 레인으로 갈린다 —
정규식·구조 대조 같은 **결정적** 레인, 문맥을 읽어야만 갈리는 **판정** 레인.
그런데 지금까지는 게이트를 만들 때마다 두 레인을 섞은 스크립트를 처음부터 다시 짰다.
매번 다시 짜니 형상이 제각각이고, 제각각이니 캐시·재현·집계가 게이트마다 따로 논다.

이 프레임워크는 그 반복을 없앤다. 저작 API 하나, 러너 하나, 그리고 그것을 실제로
쓰는 주체(LLM)를 위한 Claude Code 플러그인 하나.

## 설치

```bash
pnpm add -D gate-kernel
npx gate init
```

플러그인(게이트를 만들고 돌리는 주체가 LLM 이므로, 이쪽이 본체에 가깝다):

```
/plugin marketplace add Seungwoo321/gate-kernel
/plugin install gate-kernel@gate-kernel
```

## 30초 예제

`gates/no-direct-db.rule.mjs`:

```js
import { rule, subject } from 'gate-kernel'

export default rule('no-direct-db-in-handler', {
  criterion: '핸들러는 repository 를 거쳐 DB 에 접근한다',
  subject: subject.tree('src/handlers/**/*.ts'),
  detect: /\b(?:db|prisma|knex)\s*\./,
  severity: 'high',
  prove: [
    { name: '직접 호출은 red', files: { 'src/handlers/u.ts': 'prisma.user.findMany()' }, expect: 'red' },
    { name: 'repo 경유는 green', files: { 'src/handlers/u.ts': 'userRepo.findAll()' }, expect: 'green' },
  ],
})
```

```bash
npx gate prove   # red 를 시연하는지 먼저 확인한다
npx gate run
```

## 레인은 필드가 정한다

| 채운 필드 | 레인 | 쓰는 곳 |
|---|---|---|
| `detect: /re/` | 결정적 | 패턴 하나로 끝나는 규칙 |
| `scan(ctx) → { findings, candidates }` | 결정적 | 구조·집합·교차 대조 |
| `scan` + `judge` | 하이브리드 | `scan` 이 후보까지 좁히고, 판정자는 그 안에서만 본다 |

`judge` 를 붙이려면 `because` 에 "왜 결정적으로 못 가르는가" 를 써야 한다.
못 쓰겠으면 그건 결정적으로 되는 규칙이고, 커널이 등록을 거부한다.

## 대상(subject)

`subject` 는 열거형이 아니라 `(env) => { label, files }` 함수다. 커널은 볼 수 있는
대상을 열거하지 않는다 — 아래는 자주 쓰는 형상을 미리 쓴 헬퍼일 뿐이고, 새 대상은
게이트 파일에서 함수 하나로 쓴다.

```js
subject: (env) => ({ label: 'api-registry', files: 사내API() })  // 커널을 안 고친다
```

```js
subject.tree('docs/**/*.md')                          // 코퍼스
subject.diff({ base: 'auto' })                        // 변경분
subject.diff({ granularity: 'addedLines' })           // 추가된 줄만
subject.pair({ ref: 'PIN' }, { root: '.' }, '**/*')   // 두 트리 대조
subject.command('pnpm', { args: ['lint'], parse: 'json', baselineRef: 'auto' })  // 라이브 델타
subject.external('issues', { label: 'gate' })         // 파일이 아닌 대상
subject.rules()                                       // 룰 레지스트리 자신(메타 게이트)
subject.all({ pin: subject.diff(...), consent: subject.external('issues') })  // 축 합성
```

## 상태

게이트는 통과/실패 두 값이 아니다.

| 상태 | 뜻 |
|---|---|
| `green` | 통과 — 단 **과거에 red 를 낸 적이 있는** 게이트만 여기 온다 |
| `red` | 결함 있음 |
| `unproven` | 결함 0 건이지만 실패를 시연한 적이 없다. 초록이 아니라 "아직 모름" |
| `stale` | 기준·탐색·면제·대상 중 하나가 바뀌어 과거 판정이 무효 |
| `skipped` | 적용 대상이 아니라 안 돌았다. **통과가 아니라 미적용이다** |
| `broken` | 판정 불가. 집계에서 제외되며 통과로 세지 않는다 |

### 커버리지

결론은 게이트별로만 나지 않는다. 실행 한 번이 **무엇을 골랐고, 무엇을 돌렸고, 무엇을
증명했는가**를 `coverage` 로 같이 낸다 — `selected` / `executed` / `green` /
`unproven` / `skipped` / `gaps`.

- `unproven` 이 하나라도 있으면 그 실행은 `blocked` 다. 결함 0 건이어도 red 를 시연한 적
  없는 게이트는 초록이 아니다.
- 고른 게이트가 0개면(빈 레지스트리, 아무것도 안 고르는 스위트, 아무것도 안 걸리는
  `--rule`) 그 실행도 `blocked` 다. 검사한 것이 없는 실행은 통과가 아니다.
- `skipped` 는 갭이 아니다. 사유를 돌려준 게이트는 스스로 미적용을 선언한 것이다. 대신
  집계에서 빠진 만큼 `executed` 가 줄어 숫자로 드러난다. 전부 건너뛴 실행은 `pass` 지만
  `executed` 가 0 이고 리포트에 경고가 찍힌다.

둘을 풀어야 할 때는 설정으로 명시한다. 둘 다 기본값이 아니라 탈출구다.

```js
coverage: {
  allowEmpty: true,      // 빈 선택을 통과로 친다 — 리포트에 "검사한 것은 없다" 가 남는다
  requireProven: false,  // unproven 을 차단에서 경고로 내린다 — 실행마다 경고가 찍힌다
}
```

스위트마다 다르게 둘 수 있다(`suites.<name>.coverage`).

## 조건부 실행

늘 걸리는 게이트는 곧 무시된다. 적용 대상이 아닐 때는 `skip` 으로 비켜선다 — 단
**사유**를 돌려줘야 한다. 사유 없이 건너뛰면 `broken` 이다.

```js
skip: (slice) =>
  slice.files.some((f) => f.path.endsWith('.sql')) ? false : '이번 변경에 마이그레이션이 없다',
```

건너뛴 게이트는 통과로 세지 않고 리포트에 "이번엔 안 돌았다" 로 따로 나온다.

## 분류(tags)와 선택(suites)

게이트는 자기 소속을 선언하고(`tags`), 레포는 무엇을 돌릴지 고른다(`suites`).
태그는 트리가 아니라 패싯이라 한 게이트가 여러 축에 동시에 든다.

```js
// 게이트 쪽 — 소속
tags: ['docs/api', 'code/contract']
```

```js
// gate.config.mjs — 선택
suites: {
  docs: { include: ['docs/**'] },
  security: { include: ['security/**'], failAt: 'medium' },
  full: { extends: ['docs', 'security'] },
}
```

```bash
npx gate run docs
```

태그가 없는 게이트는 어떤 스위트에서도 빠지지 않는다(fail-closed). 대신 경고가 찍힌다.

## 필수 룰

`rules` 의 항목은 모양에 따라 뜻이 다르다.

- **글롭**(`*` `?` `{` `[` 중 하나라도 포함)은 **질의**다. 아무것도 안 걸려도 오류가 아니다.
- **리터럴 경로**는 **선언**이다. 파일이 없거나, 있어도 `rule()` 로 만든 export 가 없으면
  레지스트리가 거부되고 CLI 는 `3` 으로 끝난다. 있어도 없어도 되는 파일은 글롭으로 적는다.

파일 존재만으로는 부족할 때 **id** 로 못 박는다. `required` 는 발견이 끝난 뒤 그 id 가
등록돼 있는지를 검사한다 — 파일은 살아 있는데 다른 id 로 바뀌었거나 export 가 빠진 경우를
잡는다. 스위트의 `required` 는 그 스위트를 돌릴 때 **선택** 안에 그 id 가 있어야 한다는
뜻이다(`extends` 를 거치며 합집합). `--rule <id>` 로 좁힌 실행은 의도된 부분 실행이라
스위트 `required` 를 적용하지 않는다.

```js
// gate.config.mjs
rules: ['gates/**/*.rule.mjs', 'gates/secondary.rule.mjs'],  // 앞은 질의, 뒤는 선언
required: ['no-direct-db-in-handler'],                       // 등록돼 있어야 하는 id
suites: {
  security: { include: ['security/**'], required: ['no-secrets-in-diff'] },  // 선택에 있어야 하는 id
}
```

선언과 다르면 `init` 을 뺀 모든 명령이 설정 로드 직후에 멈춘다(fail-closed). `list` 와
`suites` 는 스위트 `required` 누락에는 멈추지 않아 진단에 쓸 수 있다.

## 면제

오탐은 게이트를 끄는 대신 사유를 남겨 면제한다. 명령이 위치를 대신 채운다 —
게이트가 실제로 낸 code 만 면제할 수 있다.

```bash
npx gate mask <rule> <code> --reason "왜 위반이 아닌가" [--until 2026-12-31]
```

결과는 커밋되는 `gate.masks.json` 에 쌓인다. 캐시에 두지 않는 이유는 gitignore 된
면제는 아무도 리뷰하지 않기 때문이다. `--until` 이 지나면 면제는 효력을 잃고 결함이
되돌아오며, 어떤 면제가 언제 만료됐는지가 같이 나온다.

## 종료 코드

모든 명령이 같은 계약을 쓴다.

| 코드 | 뜻 |
|---|---|
| `0` | 통과 |
| `1` | 실패 — red 가 있다 |
| `2` | 사용법 — 명령·플래그가 틀렸다 |
| `3` | 차단 — 미판정 · `broken` · `stale` · `unproven`(red 미시연) · 고른 게이트 0개 · 선언된 룰 누락(레지스트리 또는 스위트 `required`) |
| `20` | 판정 필요 |

`20` 이 따로 있는 이유: "아직 결론이 아님" 을 통과나 실패 어느 쪽으로도 접지 않기 위해서다.
`3` 이 `1` 과 다른 이유: 결함이 아니라 **결론을 낼 수 없는 상태**다. 고칠 것은 코드가
아니라 게이트나 설정이다.

`gate status` 도 같은 계약이다 — red 가 있으면 `1`, 행이 0개거나 `stale`/`broken`/`unproven`
이 있으면 `3`, 그 외 `0`. 종료 코드는 출력 형식에 따라 달라지지 않는다.

## CLI

```
gate init                   gate.config.mjs + gates/ 생성
gate list                   등록된 룰과 레인
gate prove [--rule <id>]    red-first 픽스처(등록 자격 검사)
gate run [<suite>] [--rule <id>] [--fresh] [--verbose]
gate judge <rule> --verdict <파일>
                            판정자가 쓴 답을 받아 커버리지를 검사하고 기록한다
gate mask <rule> <code> --reason "..." [--until YYYY-MM-DD]
                            그 결함/후보를 면제한다
gate suites                 정의된 스위트와 소속 게이트
gate pending                판정 대기 요청 출력
gate status                 게이트별 상태

공통 옵션
  --json                    기계용 JSON (= --format json). 색을 담지 않는다
  --format json|instruct|pretty
                            instruct = LLM 지시문(기본) · pretty = instruct + 색 강제
  --color auto|always|never auto = stdout 이 TTY 이고 NO_COLOR 가 없을 때만(기본)
```

형식과 색은 플래그 > 설정(`output.format` / `output.color`) > 기본 순으로 정해진다. `auto`
는 파이프·훅·CI 에서 색을 내지 않으므로 LLM 이 읽는 출력에 이스케이프 코드가 섞이지 않는다.
JSON 은 색 설정과 무관하게 이스케이프 코드를 담지 않는다. 색은 표시 층일 뿐이다 — 모든
상태는 기호와 단어(`✓ green` / `✗ red` / `~ stale` / `? unproven` / `– skipped` / `! broken`)를
그대로 가지므로 색만으로 구별해야 하는 자리는 없다(WCAG 2.2 SC 1.4.1).

판정 루프는 이렇게 닫힌다: `gate run` 이 `20` 을 내면 → 서브에이전트가 슬라이스를
읽고 JSON 으로 답하고 → `gate judge` 가 커버리지를 검사해 기록하고 → 다시 `gate run`.
후보 하나라도 답이 없으면 통과가 아니라 계약 위반이다.

## 호스트에서 쓰기

CLI 는 호출마다 새 프로세스라 아래는 해당 없다. 한 프로세스를 오래 띄우고
`gate-kernel/runtime` 을 직접 부르는 호스트를 위한 계약이다.

```js
import { loadConfig, loadRules, run, renderRun } from 'gate-kernel/runtime'

const config = await loadConfig(cwd, { reload: true })   // 새 세대로 다시 인스턴스화
const rules = await loadRules(cwd, config, { reload: true })
const result = await run({ cwd, config, rules, fresh: true })
process.stdout.write(renderRun(result, rules, { color: false }))
```

`fresh: true` 는 **판정 캐시**를 건너뛰고, `reload: true` 는 **모듈 그래프**를 새로 만든다.
둘은 별개의 보증이다. Node 는 ESM 모듈을 URL 단위로 프로세스가 끝날 때까지 캐시하므로,
`fresh` 만으로는 고쳐 쓴 룰 파일이 다시 읽히지 않는다.

`reload: true` 는 `cwd` 아래의 프로젝트 로컬 모듈 전부 — 설정, 룰 파일, 그것들이
간접적으로 import 하는 헬퍼(`checker.mjs` 같은 것)까지 — 를 새 세대로 다시 인스턴스화한다.
`node_modules` 아래(`gate-kernel` 자신 포함)는 공유된다. `generation: <id>` 를 주면 세대를
직접 고른다 — 같은 id 는 그 그래프를 재사용하고, 다른 id 는 새로 만든다. Node ≥ 20.6 이
필요하다(`module.register()` 리졸브 훅). 지난 세대는 모듈 레지스트리에 남으므로 리비전을
많이 도는 호스트는 메모리를 본다.

세대 없이 로드하면 로더가 엔트리 파일(설정 + 룰 파일)의 바이트 해시를 기억한다. 같은
프로세스에서 엔트리 바이트가 달라진 채 다시 로드하면 `StaleModuleGraphError` 가 난다 —
옛 구현이 조용히 다시 도는 대신 `{ reload: true }` 를 주라고 말한다. 이 가드는 엔트리
파일만 본다. 간접 헬퍼의 변경은 `reload` 가 담당한다.

`renderRun` / `renderProve` / `renderStatus` / `renderList` 가 `gate-kernel/runtime` 에서
export 된다(`{ color?, lang? }`). JSON 을 기본으로 내는 호스트도 사람용 렌더링을 따로
짜지 않고 CLI 와 같은 것을 쓴다. `resolveColor` / `paint` / `stripAnsi` / `ANSI_RE` /
`STATE_MARK` 도 같이 나온다.

## 플러그인이 제공하는 것

| 이름 | 하는 일 |
|---|---|
| `gate-author` 스킬 | 규칙 한 문장 → `gates/<id>.rule.mjs` + prove 통과까지 |
| `gate-run` 스킬 | `gate run` → 판정 요청 디스패치 → 재실행 → 결론 |
| `gate-judge` 에이전트 | 슬라이스 안에서만 판정한다(도구가 `Read`/`Write` 뿐) |
| `/gate`, `/gate-new`, `/gate-status` | 위 셋의 진입점 |
| SessionStart 훅 | 게이트 상태를 세션 앞단에 올린다 |
| Stop 훅 | 판정 대기를 남긴 채 턴을 끝내지 못하게 한다 |

## 설계 근거

왜 이런 형상인지는 [`docs/DESIGN.md`](docs/DESIGN.md).

## 라이선스

MIT
