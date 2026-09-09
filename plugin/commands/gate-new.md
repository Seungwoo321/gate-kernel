---
description: 새 게이트를 만든다 — 규칙을 말하면 rule 파일이 나온다
argument-hint: "<강제하고 싶은 규칙을 한 문장으로>"
---

`gate-author` 스킬을 따라 새 게이트를 만든다.

강제할 규칙: $ARGUMENTS

게이트 스크립트를 새로 짜지 말고 `gate-kernel` 의 `rule()` 로 쓴다.
`npx gate prove --rule <id>` 가 통과할 때까지 끝난 게 아니다.
