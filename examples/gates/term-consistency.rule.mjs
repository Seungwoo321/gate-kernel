import { rule, subject } from 'gate-kernel'

// 같은 프레임워크에 문서 정합 규칙을 넣으면 문서 정합 게이트가 된다.
// 결정적으로 "표기 변종"까지만 좁히고, "같은 대상인가" 만 판정자에게 넘긴다.
export default rule('term-consistency', {
  criterion: '같은 개념을 문서마다 같은 이름으로 부른다',
  subject: subject.tree('docs/**/*.md'),
  params: { canonical: ['게이트', '판정자'] },
  scan: (ctx) => {
    const canonical = ctx.params.canonical
    const findings = []
    const candidates = []
    for (const f of ctx.files()) {
      f.text.split('\n').forEach((line, i) => {
        for (const term of canonical) {
          // 결정적으로 잡히는 것: 정본 용어에 접미사가 붙은 변종
          // 한글은 `\w` 가 아니라 `\b` 가 먹지 않는다 — 접미사만 직접 나열한다.
          const re = new RegExp(`${term}(?:들|류|계)`, 'g')
          let m
          while ((m = re.exec(line)) !== null) {
            findings.push(
              ctx.finding('variant-suffix', `'${m[0]}' 은 정본 '${term}' 의 변종이다`, [
                { file: f.path, line: i + 1, column: m.index + 1, endColumn: m.index + 1 + m[0].length },
              ]),
            )
          }
          // 문맥을 읽어야만 갈리는 것: 같은 단어가 다른 축을 가리키는 경우
          if (line.includes(term) && /또는|혹은|즉/.test(line)) {
            candidates.push(
              ctx.candidate('term-axis', 'ambiguous-axis', `'${term}' 이 두 축을 동시에 가리킬 수 있다`, [
                { file: f.path, line: i + 1, quote: line.trim().slice(0, 200) },
              ]),
            )
          }
        }
      })
    }
    return { findings, candidates }
  },
  judge: {
    because: '같은 표기가 다른 축을 가리키는지는 앞뒤 문장을 읽어야만 갈린다',
    ask: '이 문장에서 해당 용어가 정본과 같은 대상을 가리키는가? 다른 축을 말하는 것이면 정상이다.',
  },
  severity: 'high',
  validates: ['glossary-canonical-terms'],
  prove: [
    {
      name: '변종 접미사는 red',
      files: { 'docs/a.md': '이 문서는 게이트들을 설명한다' },
      expect: 'red',
      code: 'term-consistency.variant-suffix',
    },
    { name: '정본만 쓰면 green', files: { 'docs/a.md': '이 문서는 게이트를 설명한다' }, expect: 'green' },
  ],
})
