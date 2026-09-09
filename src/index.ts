/**
 * gate-kernel — LLM 게이트 저작 프레임워크.
 *
 * 규칙을 넣으면 게이트가 된다. 코드 규칙을 넣으면 코드 게이트, 문서 정합 규칙을
 * 넣으면 문서 정합 게이트다. 게이트마다 러너·캐시·판정 계약·집계를 다시 만들지
 * 않는다 — 그건 전부 커널이 소유한다.
 *
 * 저자가 매번 쓰는 것은 `rules/*.rule.mjs` 하나뿐이다.
 */
export { rule, RuleDefinitionError, isRuleSpec } from './rule.ts';
export { subject, tree, diff, pair, command, external, rules } from './subject.ts';
export { defineConfig, resolveConfig, mergeConfig, DEFAULT_CONFIG } from './config.ts';
export type { GateConfig, SuiteDef, JudgeOptions, OutputOptions, ResolvedConfig, ExternalProvider } from './config.ts';
export { SEVERITY_RANK } from './types.ts';
export type {
  Severity,
  Location,
  Finding,
  Candidate,
  ScanResult,
  ScanContext,
  SubjectSpec,
  TreeRef,
  Slice,
  SliceFile,
  JudgeSpec,
  ProveCase,
  MaskSpec,
  RuleDef,
  RuleSpec,
  GateState,
  Verdict,
  RunOutcome,
} from './types.ts';
