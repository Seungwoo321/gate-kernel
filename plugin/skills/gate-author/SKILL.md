---
name: gate-author
description: 새 게이트를 만든다. 사용자가 "~를 검사하는 게이트 만들어줘", "이 규칙 강제하고 싶다", "코드 규칙/문서 정합/일관성 검사를 붙이자" 라고 할 때 쓴다. 게이트 스크립트를 처음부터 짜지 말고 이 스킬로 rule 파일을 쓴다.
---

# 게이트 저작

**게이트를 스크립트로 새로 짜지 않는다.** `gate-kernel` 의 `rule()` 하나로 쓴다.
러너·캐시·판정 계약·집계·리포트는 커널이 이미 갖고 있다. 네가 쓰는 건 규칙뿐이다.

## 0. 준비

`gate.config.mjs` 가 없으면 먼저 `npx gate init` 을 돌린다.

## 1. 기준 문장을 먼저 확정한다

`criterion` 은 장식이 아니다. 이 문장이 바뀌면 과거 판정이 전부 `stale` 이 된다.
사용자의 말을 그대로 옮기지 말고 **검사 가능한 한 문장**으로 정련한다.

- 나쁨: "코드 품질을 지킨다"
- 좋음: "핸들러는 repository 를 거쳐 DB 에 접근한다"

## 2. 레인을 고른다 — 필드가 레인을 정한다

레인 이름을 쓰지 않는다. 어떤 필드를 채우느냐가 곧 레인이다.

| 채운 필드 | 레인 | 언제 |
|---|---|---|
| `detect: /re/` | 결정적 | 패턴 하나로 끝나는 것 |
| `scan: (ctx) => ({findings, candidates})` | 결정적 | 구조·집합·교차 대조가 필요한 것 |
| `scan` + `judge` | 하이브리드 | 문맥을 읽어야만 갈리는 것 |

**기본은 결정적이다.** 판정자를 붙이려면 `judge.because` 에 "왜 결정적으로 못
가르는가" 를 써야 하고, 못 쓰겠으면 그건 결정적으로 되는 것이다. 커널이 등록을
거부한다.

판정자를 붙일 때도 **후보까지는 결정적으로 좁힌다.** `scan` 이 candidates 를
만들고 `judge` 는 그 안에서만 판정한다. 이 폐쇄성이 재게이트 루프의 고정점이다.

## 3. 대상(subject)을 고른다

`subject` 는 열거형이 아니라 함수다. 아래 헬퍼로 안 되는 대상은 커널을 고치지 말고
게이트 파일에서 함수로 쓴다 — `(env) => ({ label, files, data?, meta? })`. 해시·좁히기·
캐시 무효화는 커널이 그 위에 붙인다.

```js
subject.tree('docs/**/*.md')                       // 코퍼스 전체
subject.diff({ base: 'auto' })                     // 변경분
subject.diff({ granularity: 'addedLines' })        // 추가된 줄만 — 기존 부채를 안 떠넘긴다
subject.pair({ ref: 'PIN' }, { root: '.' }, '**/*')// 두 트리 대조(고정 원본·크로스 레포)
subject.command('pnpm', { args: ['lint'], parse: 'json', baselineRef: 'auto' })  // 라이브 델타
subject.external('issues', { label: 'gate' })      // 파일이 아닌 대상
subject.rules()                                    // 룰 레지스트리 자신(메타 게이트)
subject.all({ pin: …, consent: … })                // 판정식이 두 축을 함께 봐야 할 때만
```

지정하지 않으면 `gate.config.mjs` 의 기본 대상을 쓴다.

`subject.all` 은 축을 나누면 **판정 자체가 성립하지 않을 때만** 쓴다(예: "이 파일의
변경은 그것을 허락한 이슈의 합의가 있을 때만 통과"). 나눠도 각각 판정이 되면 나눈다 —
합치면 슬라이스가 커지고, 큰 슬라이스는 비용과 오판을 같이 키운다. 합친 축의 파일은
`f.source` 로 구별하고, 축별 데이터는 `ctx.slice.data[<축>]` 에 온다.

## 4. 소속을 단다 (tags)

`tags: ['<축>/<하위축>']` — 이 게이트가 무엇에 관한 것인가. 레포는 이걸로 스위트를
만들어 골라 돌린다(`gate run docs`). 태그는 트리가 아니라 패싯이라 한 게이트가 여러
축에 동시에 든다: `tags: ['docs/api', 'code/contract']`.

안 달면 모든 스위트에서 돈다(fail-closed) — 대신 실행마다 경고가 찍힌다.
스위트 정의는 게이트가 아니라 `gate.config.mjs` 가 소유한다. 게이트에 스위트 이름을
쓰지 않는다.

## 5. 적용 대상이 아닐 때를 정한다 (skip)

늘 걸리는 게이트는 곧 무시되는 게이트다. 대상이 없을 때는 비켜선다:

```js
skip: (slice) =>
  slice.files.some((f) => f.path.endsWith('.sql')) ? false : '이번 변경에 마이그레이션이 없다',
```

**불리언이 아니라 사유를 돌려준다.** 커널은 "원래 대상이 없다" 와 "대상이 전부
지워졌다" 를 구별할 수 없다 — 그 구별은 게이트만 한다. 사유가 비면 `broken` 이다.
건너뛴 게이트는 통과가 아니라 `skipped` 로 따로 보고된다.

`skip` 은 `match`/`subject` 로 좁히는 것의 대체가 아니다. 좁히기로 되는 것은 좁히기로
한다 — `skip` 은 "대상은 맞는데 이번엔 성립하지 않는" 경우다.

## 6. prove 픽스처를 반드시 붙인다 — red 부터

`expect: 'red'` 케이스가 없으면 그 게이트는 `unproven` 으로 태어난다.
**한 번도 실패를 보여준 적 없는 게이트는 통과를 증명하지 못한다** — 아무것도 안
하는 게이트와 구별되지 않기 때문이다. 최소 red 1개 + green 1개.

```js
prove: [
  { name: '위반이면 red', files: { 'src/a.ts': '...' }, expect: 'red', code: '<rule>.<code>' },
  { name: '정상이면 green', files: { 'src/a.ts': '...' }, expect: 'green' },
]
```

두 트리 대조 게이트는 `files` 값에 객체를 줘서 오프라인으로 증명한다:
`{ 'a.md': { text: '지금', counterpart: '원본' } }`.

## 7. 파일을 쓴다

`gates/<id>.rule.mjs`, 룰 하나당 파일 하나, `export default`.

```js
import { rule, subject } from 'gate-kernel'

export default rule('no-direct-db-in-handler', {
  criterion: '핸들러는 repository 를 거쳐 DB 에 접근한다',
  tags: ['code/layering'],
  subject: subject.tree('src/handlers/**/*.ts'),
  detect: /\b(?:db|prisma|knex)\s*\./,
  severity: 'high',
  validates: ['handler-layering'],
  prove: [
    { name: '직접 호출은 red', files: { 'src/handlers/u.ts': 'prisma.user.findMany()' }, expect: 'red' },
    { name: 'repo 경유는 green', files: { 'src/handlers/u.ts': 'userRepo.findAll()' }, expect: 'green' },
  ],
})
```

## 8. 등록을 검증한다 — 반드시 실행한다

```bash
npx gate prove --rule <id>
```

통과할 때까지 고친다. `prove` 가 red 를 시연하지 못하면 그 룰은 완성이 아니다.
파일만 쓰고 끝내는 것은 작업 완료가 아니다.

## 자주 틀리는 것

- **어드바이저리 게이트**: `advisory: true` 같은 필드는 없다. `severityCap: 'info'` 를 쓴다.
- **오탐 억제**: 줄 단위로 끄지 말고 `mask` 에 컬럼 스팬(`column`/`endColumn`)과
  `reason` 을 적는다. 줄 단위 면제는 같은 줄의 진짜 결함까지 삼킨다.
  룰에 박는 `mask` 는 **그 규칙에 본질적인 예외**만이다. 이 레포에서만 통하는 예외는
  룰을 고치지 말고 `gate mask` 로 `gate.masks.json` 에 적는다 — 커밋되고 리뷰된다.
- **기한**: `until` 은 `YYYY-MM-DD` 또는 ISO 8601 만 받는다. "다음 스프린트" 같은
  문자열은 등록에서 거부된다. 기한이 지나면 면제는 효력을 잃고 결함이 돌아온다.
  게이트가 진짜로 틀렸을 때의 정정에는 기한을 붙이지 않는다 — 그건 부채가 아니다.
- **위치 없는 결함**: 커널이 거부한다. `line: 0` 도 금지 — 파일 전체를 가리키는
  위치를 허용하면 면제 한 줄이 통째 우회로가 된다.
- **판정자에게 레포 던지기**: 불가능하다. `match`/`subject` 로 좁히지 않은 룰은
  등록에서 거부된다.
- **게이트가 늘 걸린다**: 대상에 그 파일이 없으면 아무것도 요구하지 않도록
  `subject`/`match` 를 좁힌다. 늘 걸리는 게이트는 곧 무시되는 게이트다.

## 마지막

게이트를 만들었으면 `docs` 나 `CLAUDE.md` 에 게이트 목록을 복제하지 않는다.
`npx gate list` 가 단일 진실이다.
