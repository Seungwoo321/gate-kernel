import { defineConfig, subject } from 'gate-kernel'

export default defineConfig({
  rules: ['gates/**/*.rule.mjs'],
  subject: subject.tree('**/*'),
  failAt: 'high',
})
