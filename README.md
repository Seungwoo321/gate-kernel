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

`0` 통과 · `1` 실패 · `2` 사용법 · `3` 차단 · `20` 판정 필요.

`20` 이 따로 있는 이유: "아직 결론이 아님" 을 통과나 실패 어느 쪽으로도 접지 않기 위해서다.

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
```

판정 루프는 이렇게 닫힌다: `gate run` 이 `20` 을 내면 → 서브에이전트가 슬라이스를
읽고 JSON 으로 답하고 → `gate judge` 가 커버리지를 검사해 기록하고 → 다시 `gate run`.
후보 하나라도 답이 없으면 통과가 아니라 계약 위반이다.

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
