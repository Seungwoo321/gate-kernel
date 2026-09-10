/** 러너 쪽 표면. 호스트(플러그인·헤드리스 오케스트레이터)가 쓴다. */
export { run, aggregate, storeDirOf } from './run.ts';
export type { RunOptions, RunResult, CoverageInput } from './run.ts';
export { loadConfig, loadRules, isLiteralPath, RuleRegistryError, StaleModuleGraphError } from './registry.ts';
export type { LoadOptions, MissingRule } from './registry.ts';
export { resolveSubject } from './subjects/resolve.ts';
export { runScan, makeContext } from './lanes/deterministic.ts';
export {
  buildRequest,
  writeRequest,
  writeResponse,
  responsePath,
  pendingRequests,
  allRequests,
  ingest,
  JudgeContractError,
} from './lanes/judge.ts';
export type { JudgeRequest, JudgeResponse } from './lanes/judge.ts';
export * as verdicts from './store/verdicts.ts';
export {
  DEFAULT_MASK_FILE,
  applyMaskFile,
  isExpired,
  loadMaskFile,
  maskRev,
  parseUntil,
  saveMaskFile,
} from './masks.ts';
export type { MaskFile } from './masks.ts';
export { prove } from './prove.ts';
export type { ProveResult } from './prove.ts';
export { matches, filter, matchesTag } from './glob.ts';
export { resolveSuite, selectRules, axisOf, ALL_SUITE } from './suite.ts';
export type { ResolvedSuite, Selection } from './suite.ts';
export { renderRun, renderProve, renderStatus, renderList, STATE_MARK } from './report.ts';
export type { RenderOptions, RenderPlainOptions, StatusRow } from './report.ts';
export { paint, resolveColor, stripAnsi, ANSI_RE } from './ansi.ts';
export type { Paint, ColorEnv } from './ansi.ts';
