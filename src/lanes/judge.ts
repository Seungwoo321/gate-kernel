import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Candidate, Finding, RuleSpec, Severity, Slice } from '../types.ts';
import { SEVERITY_RANK } from '../types.ts';
import { sha } from '../hash.ts';
import { sliceFilesFor } from './deterministic.ts';

/**
 * 판정 요청. **직렬화 가능해야 한다** — 판정자는 다른 컨텍스트(서브에이전트/헤드리스
 * 프로세스)에서 돈다. `judge` 를 클로저가 아니라 데이터로 둔 이유가 이것이고,
 * 이 비대칭이 테스트 프레임워크와 게이트 프레임워크가 갈리는 지점이다.
 */
export interface JudgeRequest {
  rule: string;
  criterion: string;
  /** 왜 결정적으로 못 가르는가. 판정자가 자기 역할 범위를 알게 한다. */
  because: string;
  ask: string;
  contract?: string;
  /** 판정자는 이 배열 밖으로 나갈 수 없다. */
  candidates: Candidate[];
  /** 미리 물질화된 읽기 전용 슬라이스. 판정자에게 검색 도구를 주지 않는다. */
  files: { path: string; text: string }[];
  severity: Severity;
  cap?: Severity;
  deadlineSeconds: number;
  /** 이 요청의 신원. 판정 결과 파일명·캐시 키가 된다. */
  key: string;
  /** 확인 표인가(비대칭 확인의 2표). */
  round: 1 | 2;
}

/** 판정자가 남긴 답. 심각도 필드가 **없는 것이 계약이다** — 등급은 레지스트리가 정한다. */
export interface JudgeResponse {
  rule: string;
  key: string;
  /** 후보별 판정. 후보 code 를 키로 한다. **모든 후보에 답해야 한다**(커버리지 검증). */
  decisions: { code: string; violates: boolean; why: string }[];
  round: 1 | 2;
}

export const JUDGE_DIR = 'judge';

function strictest(a?: Severity, b?: Severity): Severity | undefined {
  if (!a) return b;
  if (!b) return a;
  return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
}

export function requestKey(spec: RuleSpec, slice: Slice, candidates: Candidate[]): string {
  return sha(
    [
      spec.id,
      spec.criterionRev,
      spec.scanRev,
      slice.hash,
      candidates.map((c) => `${c.code}@${c.locations.map((l) => `${l.file}:${l.line ?? ''}`).join(',')}`).sort().join('|'),
    ].join('\n'),
  );
}

export function buildRequest(
  spec: RuleSpec,
  slice: Slice,
  candidates: Candidate[],
  opts: { deadlineSeconds: number; sliceChars: number; round: 1 | 2 },
): JudgeRequest {
  const files = sliceFilesFor(slice, candidates).map((f) => ({
    path: f.path,
    text: f.text.length > opts.sliceChars ? `${f.text.slice(0, opts.sliceChars)}\n…[truncated]` : f.text,
  }));
  const j = spec.judge!;
  // 두 상한 중 **낮은 쪽**을 쓴다. 축 상한(`judge.cap`)이 룰 상한(`severityCap`)을
  // 넘으면 어드바이저리로 선언한 게이트가 판정 레인을 통해서만 차단 등급을 내는
  // 구멍이 생긴다 — 상한은 상한끼리 겹칠 때 더 조여야 상한이다.
  const cap = strictest(j.cap, spec.severityCap);
  return {
    rule: spec.id,
    criterion: spec.criterion,
    because: j.because,
    ask: j.ask,
    contract: j.contract,
    candidates,
    files,
    severity: spec.severity ?? 'high',
    cap,
    deadlineSeconds: opts.deadlineSeconds,
    key: requestKey(spec, slice, candidates),
    round: opts.round,
  };
}

/**
 * 파일 계약. 판정자는 최종 메시지로 JSON 을 돌려주지 않고 파일에 쓴다.
 * 그래야 **산문으로 답하는 우회로가 실패로 귀결**된다 — 통과가 아니라.
 */
export function writeRequest(storeDir: string, req: JudgeRequest): string {
  const dir = join(storeDir, JUDGE_DIR, req.key.slice(0, 8));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${req.rule}.r${req.round}.request.json`);
  writeFileSync(path, `${JSON.stringify(req, null, 2)}\n`, 'utf8');
  dropStaleSlots(storeDir, req);
  return path;
}

/**
 * 다른 키 슬롯에 남은 같은 룰의 요청을 지운다.
 *
 * 안 지우면 대상이 바뀔 때마다 미응답 요청이 쌓이고, 아무도 답할 수 없는 그것들이
 * `gate pending` 을 영원히 비지 않게 만든다 — 종료 코드 20 이 고착돼 "판정 필요" 가
 * 신호가 아니라 배경 소음이 된다. 덤으로 **한 룰에 미응답 요청은 최대 하나**라는
 * 불변식이 서고, `gate judge <rule>` 이 대상을 헤맬 일이 없어진다.
 */
function dropStaleSlots(storeDir: string, req: JudgeRequest): void {
  const root = join(storeDir, JUDGE_DIR);
  const keep = req.key.slice(0, 8);
  for (const slot of readdirSync(root)) {
    if (slot === keep) continue;
    const dir = join(root, slot);
    const names = readdirSync(dir);
    for (const name of names) {
      if (name.startsWith(`${req.rule}.`)) rmSync(join(dir, name));
    }
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
  }
}

export function responsePath(storeDir: string, req: JudgeRequest): string {
  return join(storeDir, JUDGE_DIR, req.key.slice(0, 8), `${req.rule}.r${req.round}.verdict.json`);
}

export function allRequests(storeDir: string): JudgeRequest[] {
  const root = join(storeDir, JUDGE_DIR);
  if (!existsSync(root)) return [];
  const out: JudgeRequest[] = [];
  for (const slot of readdirSync(root)) {
    const dir = join(root, slot);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.request.json')) continue;
      out.push(JSON.parse(readFileSync(join(dir, name), 'utf8')) as JudgeRequest);
    }
  }
  return out;
}

export function pendingRequests(storeDir: string): JudgeRequest[] {
  return allRequests(storeDir).filter((req) => !existsSync(responsePath(storeDir, req)));
}

export function writeResponse(storeDir: string, req: JudgeRequest, res: JudgeResponse): string {
  const path = responsePath(storeDir, req);
  writeFileSync(path, `${JSON.stringify(res, null, 2)}\n`, 'utf8');
  return path;
}

export class JudgeContractError extends Error {}

/**
 * 커버리지 검증: 판정자가 후보 일부를 조용히 빠뜨리면 그 후보는 **통과가 아니라
 * 미판정**이다. 답이 없는 후보가 있으면 계약 위반으로 던진다(fail-closed).
 */
export function ingest(req: JudgeRequest, res: JudgeResponse): Finding[] {
  if (res.rule !== req.rule || res.key !== req.key) {
    throw new JudgeContractError(`판정 응답이 요청과 다르다: ${res.rule}/${res.key}`);
  }
  const answered = new Map(res.decisions.map((d) => [d.code, d]));
  const missing = req.candidates.filter((c) => !answered.has(c.code));
  if (missing.length) {
    throw new JudgeContractError(
      `후보 ${missing.length}건이 미판정이다: ${missing.map((c) => c.code).join(', ')}`,
    );
  }
  const cap = req.cap;
  const sev: Severity =
    cap && SEVERITY_RANK[req.severity] > SEVERITY_RANK[cap] ? cap : req.severity;

  return req.candidates
    .filter((c) => answered.get(c.code)!.violates)
    .map<Finding>((c) => ({
      rule: req.rule,
      code: c.code,
      severity: sev,
      message: `${c.message} — ${answered.get(c.code)!.why}`,
      locations: c.locations,
      foundBy: 'judge',
      payload: c.payload,
    }));
}
