import { rule, subject } from 'gate-kernel'

// 코드 규칙을 넣으면 코드 게이트가 된다. 선언형 탐지만으로 끝나는 최소형.
export default rule('no-direct-db-in-handler', {
  criterion: '핸들러는 repository 를 거쳐 DB 에 접근한다',
  subject: subject.tree('src/handlers/**/*.ts'),
  detect: /\b(?:db|prisma|knex)\s*\./,
  severity: 'high',
  validates: ['handler-layering'],
  prove: [
    {
      name: '핸들러가 prisma 를 직접 부르면 red',
      files: { 'src/handlers/user.ts': 'export const get = () => prisma.user.findMany()' },
      expect: 'red',
    },
    {
      name: 'repository 경유는 green',
      files: { 'src/handlers/user.ts': 'export const get = () => userRepo.findAll()' },
      expect: 'green',
    },
  ],
})
