---
description: 게이트별 상태(unproven/red/green/stale/skipped/broken)를 본다
---

```bash
npx gate status --json
```

를 돌리고 결과를 표로 요약한다. 다음을 명시적으로 구분해 보고한다:

- `green` — 통과. 단 **과거에 red 를 낸 적이 있는** 게이트만 여기 온다.
- `unproven` — 결함 0 건이지만 실패를 시연한 적이 없다. 초록이 아니라 "아직 모름".
- `stale` — 기준·탐색·면제·대상 중 하나가 바뀌어 과거 판정이 무효다. 통과가 아니다.
- `skipped` — 적용 대상이 아니라 이번엔 안 돌았다. 통과가 아니라 미적용이다.
- `broken` — 판정 불가. 집계에서 제외되며, 통과로 세면 안 된다.

`unproven` 이나 `stale` 이 있으면 그것을 해소하는 다음 행동까지 제안한다.

종료 코드는 `gate run` 과 같은 계약이다:

- `1` — `red` 가 있다.
- `3` — `unproven`/`stale`/`broken` 이 있거나 행이 0개다. 통과가 아니다. 설정의
  `coverage.allowEmpty` / `coverage.requireProven` 으로 푼 경우에만 예외다.
- `0` — 그 외.

파싱하는 것은 `--json` 출력이다. `--color always` 는 사람이 보는 터미널용이고, JSON 에는
색이 섞이지 않는다.
