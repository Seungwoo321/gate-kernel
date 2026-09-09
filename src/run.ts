import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Finding, MaskSpec, RunOutcome, RuleSpec, Severity, Slice, Verdict } from './types.ts';
import { SEVERITY_RANK } from './types.ts';
import { DEFAULT_CONFIG, resolveConfig, type GateConfig } from './config.ts';
import { resolveSubject } from './subjects/resolve.ts';
import { subject } from './subject.ts';
import { runScan } from './lanes/deterministic.ts';
import {
  buildRequest,
  ingest,
  JudgeContractError,
  responsePath,
  writeRequest,
  type JudgeRequest,
  type JudgeResponse,
} from './lanes/judge.ts';
import * as store from './store/verdicts.ts';

export interface RunOptions {
  cwd: string;
  config: GateConfig;
  rules: RuleSpec[];
  /** 특정 룰만 돌린다. */
  only?: string[];
  /** 캐시를 무시하고 전부 다시 판정한다. */
  fresh?: boolean;
}

export interface RunResult extends RunOutcome {
  /** 판정자를 기다리는 요청. 비어 있지 않으면 아직 결론이 아니다. */
  pending: JudgeRequest[];
  /**
   * 이번 실행에서 기한이 지나 효력을 잃은 면제. 판정을 기다리느라 판정문이 남지
   * 않는 룰도 여기 실린다 — 결함이 왜 되돌아왔는지가 그 라운드에서 사라지면
   * 사용자는 게이트가 고장 난 줄 안다.
   */
  expired: { rule: string; masks: MaskSpec[] }[];
}

const EMPTY_COUNTS = (): Record<Severity, number> => ({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
});

function readResponse(storeDir: string, req: JudgeRequest): JudgeResponse | null {
  const p = responsePath(storeDir, req);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as JudgeResponse;
  } catch {
    return null;
  }
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const cfg = resolveConfig(opts.config);
  const storeDir = resolve(opts.cwd, cfg.store);
  const targets = opts.only?.length
    ? opts.rules.filter((r) => opts.only!.includes(r.id))
    : opts.rules;

  const verdicts: Verdict[] = [];
  const pending: JudgeRequest[] = [];
  const unjudged: string[] = [];
  const expired: { rule: string; masks: MaskSpec[] }[] = [];

  /**
   * 판정을 기다리는 동안에도 **이미 결정된 결함은 지금 낸다.**
   * 고칠 수 있는 것을 판정 라운드 뒤로 숨기면 한 번에 끝날 일이 두 라운드가 된다.
   * 저장하지는 않는다 — 판정 몫이 빠진 부분 판정을 캐시하면 다음 실행이 그것을
   * 완결된 판정으로 재생한다.
   */
  const emitPartial = (spec: RuleSpec, findings: Finding[], slice: Slice, t0: number): void => {
    if (!findings.length) return;
    store.markProvenRed(storeDir, spec.id, 'run');
    verdicts.push({
      rule: spec.id,
      state: 'red',
      findings,
      key: `${spec.criterionRev}:${spec.scanRev}:${spec.maskRev}:${slice.hash}`,
      criterionRev: spec.criterionRev,
      scanRev: spec.scanRev,
      maskRev: spec.maskRev,
      subjectHash: slice.hash,
      lane: spec.lane,
      cacheHit: false,
      wallMs: Date.now() - t0,
      at: new Date().toISOString(),
    });
  };

  for (const spec of targets) {
    const t0 = Date.now();
    let slice: Slice;
    try {
      slice = await resolveSubject(
        spec.subject ?? cfg.subject ?? subject.tree('**/*'),
        { cwd: opts.cwd, config: cfg, registry: opts.rules },
        spec.match,
      );
    } catch (e) {
      // 대상을 못 만들면 통과가 아니라 broken 이다(fail-closed).
      verdicts.push(broken(spec, `subject 해소 실패: ${(e as Error).message}`, t0));
      unjudged.push(spec.id);
      continue;
    }

    if (spec.skip) {
      let why: string | false;
      try {
        why = await spec.skip(slice, spec.params ?? {});
      } catch (e) {
        verdicts.push(broken(spec, `skip 판정 실패: ${(e as Error).message}`, t0, slice));
        unjudged.push(spec.id);
        continue;
      }
      if (why) {
        // 사유 없는 건너뛰기는 조용한 초록과 같다 — 계약 위반으로 잡는다.
        if (typeof why !== 'string' || !why.trim()) {
          verdicts.push(broken(spec, 'skip 은 사유 문자열을 돌려줘야 한다', t0, slice));
          unjudged.push(spec.id);
          continue;
        }
        // 캐시보다 앞에서 판정한다. 값이 싸고(이미 만든 슬라이스 위의 술어),
        // 캐시된 green 이 "안 도는 게이트" 를 통과로 재생하는 것을 막아야 한다.
        verdicts.push(skipped(spec, why.trim(), t0, slice));
        continue;
      }
    }

    const prev = store.load(storeDir, spec.id);
    const freshness = store.stalenessOf(prev, spec, slice);
    if (!opts.fresh && freshness.fresh && prev) {
      // 상태는 캐시에서 그대로 재생하지 않고 다시 판정한다. `unproven`/`green` 은
      // 결함 수만의 함수가 아니라 red 시연 여부와의 곱이고, 시연은 판정을 캐시한
      // 뒤에도(예: `gate prove`) 성립할 수 있다.
      verdicts.push({
        ...prev,
        state: store.stateOf({
          hasFindings: prev.findings.length > 0,
          provenRed: store.hasProvenRed(storeDir, spec.id),
        }),
        cacheHit: true,
        at: new Date().toISOString(),
      });
      continue;
    }

    let scan;
    try {
      scan = await runScan(spec, slice, spec.params ?? {});
    } catch (e) {
      verdicts.push(broken(spec, `scan 실패: ${(e as Error).message}`, t0, slice));
      unjudged.push(spec.id);
      continue;
    }

    if (scan.expired.length) expired.push({ rule: spec.id, masks: scan.expired });

    let findings: Finding[] = scan.findings;
    let judgeCalls = 0;

    if (spec.judge && scan.candidates.length > 0) {
      // 비대칭 확인: 1라운드에서 위반이 나오면 red 를 그대로 채택하고,
      // 위반이 하나도 없을 때(= green 으로 넘어갈 때)만 확인 표를 요구한다.
      const r1 = buildRequest(spec, slice, scan.candidates, {
        deadlineSeconds: cfg.judge.deadlineSeconds,
        sliceChars: cfg.judge.sliceChars,
        round: 1,
      });
      const res1 = readResponse(storeDir, r1);
      if (!res1) {
        writeRequest(storeDir, r1);
        pending.push(r1);
        unjudged.push(spec.id);
        emitPartial(spec, findings, slice, t0);
        continue;
      }
      judgeCalls += 1;
      let judged: Finding[];
      try {
        judged = ingest(r1, res1);
      } catch (e) {
        const why = e instanceof JudgeContractError ? e.message : String(e);
        verdicts.push(broken(spec, `판정 계약 위반: ${why}`, t0, slice));
        unjudged.push(spec.id);
        continue;
      }

      const wantConfirm = spec.judge.confirm !== false;
      if (judged.length === 0 && wantConfirm) {
        const r2 = buildRequest(spec, slice, scan.candidates, {
          deadlineSeconds: cfg.judge.deadlineSeconds,
          sliceChars: cfg.judge.sliceChars,
          round: 2,
        });
        const res2 = readResponse(storeDir, r2);
        if (!res2) {
          writeRequest(storeDir, r2);
          pending.push(r2);
          unjudged.push(spec.id);
          emitPartial(spec, findings, slice, t0);
          continue;
        }
        judgeCalls += 1;
        try {
          const confirm = ingest(r2, res2);
          // 이견이면 red 를 유지한다 — 단측 오류를 통과 쪽이 아니라 차단 쪽에 둔다.
          judged = confirm;
        } catch (e) {
          verdicts.push(broken(spec, `확인 판정 계약 위반: ${(e as Error).message}`, t0, slice));
          unjudged.push(spec.id);
          continue;
        }
      }
      findings = [...findings, ...judged];
    }

    if (findings.length > 0) store.markProvenRed(storeDir, spec.id, 'run');
    const state = store.stateOf({
      hasFindings: findings.length > 0,
      provenRed: store.hasProvenRed(storeDir, spec.id),
    });

    const v: Verdict = {
      rule: spec.id,
      state,
      findings,
      key: `${spec.criterionRev}:${spec.scanRev}:${spec.maskRev}:${slice.hash}`,
      criterionRev: spec.criterionRev,
      scanRev: spec.scanRev,
      maskRev: spec.maskRev,
      subjectHash: slice.hash,
      lane: spec.lane,
      judgeCalls,
      cacheHit: false,
      wallMs: Date.now() - t0,
      at: new Date().toISOString(),
      ...(scan.expired.length ? { expiredMasks: scan.expired } : {}),
    };
    store.save(storeDir, v);
    verdicts.push(v);
  }

  return { ...aggregate(verdicts, cfg.failAt, unjudged, startedAt), pending, expired };
}

function marker(
  spec: RuleSpec,
  state: 'broken' | 'skipped',
  reason: string,
  t0: number,
  slice?: Slice,
): Verdict {
  return {
    rule: spec.id,
    state,
    findings: [],
    key: state,
    criterionRev: spec.criterionRev,
    scanRev: spec.scanRev,
    maskRev: spec.maskRev,
    subjectHash: slice?.hash ?? '',
    lane: spec.lane,
    reason,
    wallMs: Date.now() - t0,
    at: new Date().toISOString(),
  };
}

function broken(spec: RuleSpec, reason: string, t0: number, slice?: Slice): Verdict {
  return marker(spec, 'broken', reason, t0, slice);
}

function skipped(spec: RuleSpec, reason: string, t0: number, slice?: Slice): Verdict {
  return marker(spec, 'skipped', reason, t0, slice);
}

export function aggregate(
  verdicts: Verdict[],
  failAt: Severity,
  unjudged: string[],
  startedAt: string,
): RunOutcome {
  const counts = EMPTY_COUNTS();
  // `broken` 과 `skipped` 는 집계에서 제외한다 — 판정 못 했거나 안 돈 것을 0 건으로
  // 세면 통과로 보인다. 대신 리포트가 둘을 각각 이름 붙여 낸다.
  for (const v of verdicts) {
    if (v.state === 'broken' || v.state === 'skipped') continue;
    for (const f of v.findings) counts[f.severity] += 1;
  }
  const failing = (Object.keys(counts) as Severity[]).some(
    (s) => SEVERITY_RANK[s] >= SEVERITY_RANK[failAt] && counts[s] > 0,
  );
  // 미판정·broken 이 하나라도 있으면 통과가 아니다. 판정 불가는 통과가 아니다.
  const blocked = unjudged.length > 0 || verdicts.some((v) => v.state === 'broken' || v.state === 'stale');
  return {
    verdicts,
    outcome: failing ? 'fail' : blocked ? 'blocked' : 'pass',
    counts,
    unjudged,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

export function storeDirOf(cwd: string, config: GateConfig): string {
  return join(cwd, config.store ?? DEFAULT_CONFIG.store);
}
