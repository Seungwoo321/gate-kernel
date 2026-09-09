---
description: 등록된 게이트를 실행하고 판정 레인까지 끝낸다
argument-hint: "[스위트|룰 id] [--fresh]"
---

`gate-run` 스킬을 따라 게이트를 끝까지 실행한다.

인자: $ARGUMENTS

- 인자가 룰 id 면 `--rule <id>` 로 그 게이트만 돌린다.
- `--fresh` 가 있으면 캐시를 무시하고 전부 다시 판정한다.
- 인자가 없으면 전체를 돌린다.

인자에 스위트 이름을 주면 그 스위트만 돌린다(`/gate docs`). 스위트 목록은
`npx gate suites`.

판정 대기(`exit 20`)가 남은 채로 끝내지 않는다. 판정자의 답은 반드시
`npx gate judge <rule> --verdict <파일>` 로 들여보낸다 — 커버리지 검사가 거기 있다.
