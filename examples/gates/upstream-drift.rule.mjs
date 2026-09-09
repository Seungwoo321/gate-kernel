import { rule, subject } from 'gate-kernel'

// 고정 원본 대비 표류. 벤더 사본 동기화, 상위 스킬 사본 확인, 산출물 계보 추적이
// 전부 같은 형상이다 — 대상이 "한 트리" 가 아니라 "두 트리의 대조" 라는 점만 다르다.
export default rule('upstream-drift', {
  criterion: '복사본은 고정한 원본 리비전과 같은 내용이어야 한다',
  subject: subject.pair(
    { ref: 'ORIGIN_PIN', root: '.' },
    { root: '.' },
    'vendor/**/*.md',
  ),
  scan: (ctx) => ({
    findings: ctx
      .files()
      .filter((f) => f.counterpart != null && f.counterpart !== f.text)
      .map((f) =>
        ctx.finding('drifted', `고정 원본과 내용이 다르다 — 재동기화하거나 핀을 올려라`, [
          { file: f.path, line: 1 },
        ]),
      ),
    candidates: [],
  }),
  severity: 'high',
  validates: ['vendor-pin'],
  prove: [
    {
      name: '원본과 다르면 red',
      files: { 'vendor/a.md': { text: 'changed', counterpart: 'original' } },
      expect: 'red',
      code: 'upstream-drift.drifted',
    },
    {
      name: '원본과 같으면 green',
      files: { 'vendor/a.md': { text: 'same', counterpart: 'same' } },
      expect: 'green',
    },
  ],
})
