import { rule, subject } from 'gate-kernel'

// 메타 게이트. 대상이 룰 레지스트리 자신이라, "모든 산출물에 검증자가 있는가" 를
// 프레임워크 안에서 물을 수 있다. 손으로 짠 하네스라면 룰 소스를 정규식으로 긁어
// 선언을 찾아야 하지만, 여기서는 `validates` 가 룰의 일급 필드라 레지스트리 조회로 끝난다.
export default rule('validator-coverage', {
  criterion: '선언된 모든 산출물 키에 그것을 강제하는 룰이 하나 이상 있다',
  subject: subject.rules(),
  params: {
    required: ['handler-layering', 'glossary-canonical-terms', 'vendor-pin'],
    waivers: {},
  },
  scan: (ctx) => {
    const registered = Array.isArray(ctx.slice.data) ? ctx.slice.data : []
    const covered = new Set(registered.flatMap((r) => r.validates ?? []))
    const findings = ctx.params.required
      .filter((k) => !covered.has(k) && !(k in ctx.params.waivers))
      .map((k) =>
        ctx.finding(
          'no-validator',
          `'${k}' 를 강제하는 룰이 없다 — 룰에 \`validates: ['${k}']\` 를 달거나 사유와 함께 waivers 에 적어라`,
          [{ file: 'gate.config.mjs', line: 1 }],
        ),
      )
    return { findings, candidates: [] }
  },
  severity: 'critical',
  prove: [
    {
      name: '커버되지 않은 키가 있으면 red',
      files: {},
      params: { required: ['missing-key'], waivers: {} },
      expect: 'red',
      code: 'validator-coverage.no-validator',
    },
  ],
})
