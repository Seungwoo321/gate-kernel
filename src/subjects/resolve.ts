import type { Slice, SliceFile, Subject, SubjectEnv, RuleSpec } from '../types.ts';
import type { GateConfig } from '../config.ts';
import { matches } from '../glob.ts';
import { sha, stableStringify } from '../hash.ts';

/**
 * 슬라이스 해시. **커널이 계산한다** — subject 함수는 몸통만 돌려준다.
 * 이 소유권이 개방의 안전장치다: 대상을 아무리 새로 만들어도 캐시 키와
 * staleness 3축(§7)은 사용자가 건드릴 수 없다.
 */
function hashOf(files: SliceFile[], data: unknown): string {
  return sha(
    files
      .map(
        (f) =>
          `${f.source ?? ''}|${f.path} ${sha(f.text, 32)} ${sha(f.counterpart ?? '', 32)} ${(f.addedLines ?? []).join(',')}`,
      )
      .sort()
      .join('\n') + `${sha(stableStringify(data ?? null), 32)}`,
  );
}

export interface ResolveEnv {
  cwd: string;
  config: GateConfig;
  /** 메타 게이트를 위해 레지스트리를 주입한다. */
  registry?: RuleSpec[];
}

/**
 * 대상을 해소한다. 커널이 하는 일은 셋뿐이다 — 함수를 부르고, 좁히고, 해싱한다.
 * **무엇을 볼지는 분기하지 않는다.** 종류를 열거하는 순간 소비자마다 커널을
 * 고쳐야 하고, 그러면 프레임워크가 아니다.
 */
export async function resolveSubject(
  subject: Subject,
  env: ResolveEnv,
  narrow?: string | string[],
): Promise<Slice> {
  const narrowList = narrow ? (Array.isArray(narrow) ? narrow : [narrow]) : undefined;

  const senv: SubjectEnv = {
    cwd: env.cwd,
    config: env.config,
    registry: env.registry ?? [],
    ...(narrowList ? { narrow: narrowList } : {}),
  };

  const body = await subject(senv);

  // 좁히기는 커널이 보증한다. subject 가 `env.narrow` 를 참고해 덜 읽을 수는 있어도,
  // 지키지 않아도 결과는 같아야 한다.
  const files = narrowList
    ? (body.files ?? []).filter((f) => matches(f.path, narrowList))
    : (body.files ?? []);
  const data = body.data ?? null;

  return {
    kind: body.label ?? 'custom',
    files,
    data,
    meta: body.meta ?? {},
    hash: hashOf(files, data),
  };
}
