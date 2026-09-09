import type {
  Candidate,
  Finding,
  Location,
  MaskSpec,
  RuleSpec,
  ScanContext,
  ScanResult,
  Severity,
  Slice,
  SliceFile,
} from '../types.ts';
import { SEVERITY_RANK } from '../types.ts';
import { matches } from '../glob.ts';
import { isExpired } from '../masks.ts';

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function makeContext(spec: RuleSpec, slice: Slice, params: Record<string, unknown>): ScanContext {
  // 합성 대상(`subject.all`)에서는 같은 경로가 두 축에 있을 수 있다. 먼저 온 축이
  // 경로 키를 잡고, 축을 지정해 읽고 싶으면 `<축>:<경로>` 로 읽는다.
  const byPath = new Map<string, SliceFile>();
  for (const f of slice.files) {
    if (!byPath.has(f.path)) byPath.set(f.path, f);
    if (f.source) byPath.set(`${f.source}:${f.path}`, f);
  }

  const loc = (l: Location): Location => {
    if (l.line === 0) throw new Error(`[${spec.id}] location.line 0 은 금지다 — 파일 전체를 가리키면 면제가 통째 우회로가 된다`);
    return l;
  };

  return {
    slice,
    params,
    read(path: string): string {
      const f = byPath.get(path);
      if (!f) {
        // 폐쇄성: 슬라이스 밖은 읽을 수 없다. 읽히면 탐색 범위가 룰마다 달라져 고정점이 깨진다.
        throw new Error(`[${spec.id}] '${path}' 는 이 룰의 슬라이스 밖이다`);
      }
      return f.text;
    },
    files: () => slice.files,
    finding(code, message, locations, extra) {
      if (!KEBAB.test(code)) throw new Error(`[${spec.id}] finding code 는 kebab-case 여야 한다: ${code}`);
      if (!locations.length) throw new Error(`[${spec.id}] 위치 없는 결함은 확인할 수 없다: ${code}`);
      return {
        rule: spec.id,
        code: `${spec.id}.${code}`,
        severity: spec.severity ?? 'high',
        message,
        locations: locations.map(loc),
        foundBy: 'scan',
        ...extra,
      };
    },
    candidate(kind, code, message, locations, payload) {
      if (!KEBAB.test(code)) throw new Error(`[${spec.id}] candidate code 는 kebab-case 여야 한다: ${code}`);
      if (!locations.length) throw new Error(`[${spec.id}] 위치 없는 후보는 판정할 수 없다: ${code}`);
      return { kind, code: `${spec.id}.${code}`, message, locations: locations.map(loc), payload };
    },
  };
}

function runDetect(spec: RuleSpec, ctx: ScanContext): Finding[] {
  if (spec.detect == null) return [];
  const patterns = Array.isArray(spec.detect) ? spec.detect : [spec.detect];
  const out: Finding[] = [];
  for (const f of ctx.files()) {
    const lines = f.text.split('\n');
    for (const re of patterns) {
      for (let i = 0; i < lines.length; i += 1) {
        const lineNo = i + 1;
        // addedLines 가 있으면 추가된 줄만 본다 — 기존 부채를 새 변경에 떠넘기지 않는다.
        if (f.addedLines && !f.addedLines.includes(lineNo)) continue;
        const text = lines[i]!;
        const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
        const scoped = new RegExp(re.source, flags);
        let m: RegExpExecArray | null;
        while ((m = scoped.exec(text)) !== null) {
          out.push(
            ctx.finding(
              'match',
              m[0] ? `금지 패턴 \`${m[0]}\` 이 나타난다` : '이 줄이 탐지 패턴에 걸린다',
              [
                {
                  file: f.path,
                  line: lineNo,
                  column: m.index + 1,
                  endColumn: m.index + 1 + m[0].length,
                  quote: text.trim().slice(0, 200),
                },
              ],
            ),
          );
          if (m[0].length === 0) scoped.lastIndex += 1;
        }
      }
    }
  }
  return out;
}

/** 마스크가 가리키는 대상. 결함과 후보가 같은 모양이라 둘 다 같은 규칙으로 면제된다. */
interface Maskable {
  code: string;
  locations: Location[];
}

/**
 * 컬럼 정밀 마스킹. 줄 단위 마스킹은 같은 줄의 진짜 결함까지 삼킨다(실증).
 * 매치된 마스크를 돌려준다 — 만료된 마스크를 세어 리포트에 올리기 위해서다.
 */
function maskFor(spec: RuleSpec, item: Maskable): MaskSpec | undefined {
  for (const m of spec.mask ?? []) {
    if (m.code && m.code !== item.code) continue;
    for (const l of item.locations) {
      if (!matches(l.file, m.file)) continue;
      if (m.line != null && l.line !== m.line) continue;
      if (m.column != null) {
        const start = l.column ?? -1;
        const end = l.endColumn ?? start;
        if (start < m.column || end > (m.endColumn ?? m.column)) continue;
      }
      return m;
    }
  }
  return undefined;
}

function capped(sev: Severity, cap?: Severity): Severity {
  if (!cap) return sev;
  return SEVERITY_RANK[sev] > SEVERITY_RANK[cap] ? cap : sev;
}

export interface ScanOutcome extends ScanResult {
  masked: number;
  /** 이번 실행에 걸렸으나 기한이 지나 효력을 잃은 마스크. */
  expired: MaskSpec[];
}

export async function runScan(
  spec: RuleSpec,
  slice: Slice,
  params: Record<string, unknown>,
  now: Date = new Date(),
): Promise<ScanOutcome> {
  const ctx = makeContext(spec, slice, params);
  const detected = runDetect(spec, ctx);
  const scanned: ScanResult = spec.scan
    ? await spec.scan(ctx)
    : { findings: [], candidates: [] };

  const expired = new Map<string, MaskSpec>();
  // 후보도 결함과 같은 규칙으로 면제한다. 여기서 안 거르면 "위반 아님" 판정을
  // 남겨도 다음 실행이 같은 후보를 다시 판정자에게 보낸다 — 리포트가 약속한
  // "다음부터 안 묻는다" 가 지켜지지 않는다.
  const keep = <T extends Maskable>(item: T): boolean => {
    const m = maskFor(spec, item);
    if (!m) return true;
    if (!isExpired(m, now)) return false;
    // 만료된 면제는 없는 면제다. 조용히 되살리지 않고 왜 돌아왔는지를 남긴다.
    expired.set(`${m.file}:${m.line ?? ''}:${m.code ?? ''}`, m);
    return true;
  };

  const all = [...detected, ...(scanned.findings ?? [])];
  const kept = all.filter(keep);
  const candidates = (scanned.candidates ?? []).filter(keep);
  return {
    findings: kept.map((f) => ({ ...f, severity: capped(f.severity, spec.severityCap) })),
    candidates,
    masked: all.length - kept.length + ((scanned.candidates ?? []).length - candidates.length),
    expired: [...expired.values()],
  };
}

export function sliceFilesFor(slice: Slice, candidates: Candidate[]): SliceFile[] {
  const wanted = new Set(candidates.flatMap((c) => c.locations.map((l) => l.file)));
  return slice.files.filter((f) => wanted.has(f.path));
}
