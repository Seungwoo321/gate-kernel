import { readdirSync, readFileSync, realpathSync, statSync, existsSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RuleSpec } from './types.ts';
import { isRuleSpec } from './rule.ts';
import { DEFAULT_CONFIG, resolveConfig, type ResolvedConfig, type GateConfig } from './config.ts';
import { matches } from './glob.ts';
import { sha } from './hash.ts';
import { applyMaskFile, loadMaskFile } from './masks.ts';
import { GENERATION_PARAM, ROOT_PARAM } from './loader-hooks.ts';

const SKIP = new Set(['.git', 'node_modules', 'dist', '.gate']);
const CONFIG_NAMES = ['gate.config.mjs', 'gate.config.js', 'gate.config.ts'];

function walk(root: string, acc: string[] = [], base = root): string[] {
  if (!existsSync(root)) return acc;
  for (const name of readdirSync(root)) {
    if (SKIP.has(name)) continue;
    const full = join(root, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc, base);
    else acc.push(relative(base, full).split(sep).join('/'));
  }
  return acc;
}

/** 글롭 메타문자가 하나라도 있으면 질의, 없으면 선언(리터럴 경로)이다. */
export function isLiteralPath(pattern: string): boolean {
  return !/[*?{[]/.test(pattern);
}

export interface MissingRule {
  /** `path` = `rules` 의 리터럴 경로가 해소되지 않음, `id` = `required` 의 룰 id 가 등록되지 않음. */
  kind: 'path' | 'id';
  ref: string;
  reason: string;
}

/**
 * 레지스트리가 선언된 형상과 다르다. 통과가 아니라 등록 거부다 — 적어 둔 룰이 사라졌는데
 * 남은 룰이 통과해서 exit 0 이 나오는 것은, 이 프레임워크가 막으려는 "조용한 초록" 의
 * 레지스트리 판이다.
 */
export class RuleRegistryError extends Error {
  constructor(readonly missing: MissingRule[]) {
    super(
      [
        '룰 레지스트리가 선언과 다르다:',
        ...missing.map((m) => `  - ${m.kind === 'path' ? '경로' : '룰 id'} ${m.ref}: ${m.reason}`),
      ].join('\n'),
    );
    this.name = 'RuleRegistryError';
  }
}

// ---------------------------------------------------------------------------
// 프로세스 내 재로드
// ---------------------------------------------------------------------------

/**
 * 같은 프로세스에서 두 번째로 로드할 때 첫 로드와 다른 바이트가 디스크에 있다.
 * Node 의 ESM 레지스트리는 URL 로 모듈을 영구 캐시하므로, 재로드 없이 다시 import 하면
 * **옛 구현이 새로 실행**된다 — 판정 캐시를 우회해도(`fresh: true`) 탐색 함수 자체가
 * 옛것이라 결과가 옛 바이트를 따른다. 그 상태를 통과로 두지 않고 여기서 끊는다.
 */
export class StaleModuleGraphError extends Error {
  constructor(readonly changed: string[]) {
    super(
      [
        '로드된 모듈 그래프가 디스크와 다르다. 같은 프로세스에서 바뀐 파일:',
        ...changed.map((p) => `  - ${p}`),
        '`loadConfig`/`loadRules` 에 `{ reload: true }` 를 주면 프로젝트 로컬 모듈 전부를 새 세대로 다시 인스턴스화한다.',
      ].join('\n'),
    );
    this.name = 'StaleModuleGraphError';
  }
}

export interface LoadOptions {
  /**
   * 새 세대로 로드한다. 프로젝트 로컬 모듈(설정·룰·룰이 import 한 헬퍼)은 전부 새로
   * 인스턴스화되고, `node_modules` 아래 패키지는 그대로 공유된다. 세대마다 옛 모듈이
   * 레지스트리에 남으므로 리비전을 무한히 돌리는 호스트는 메모리를 감시해야 한다.
   */
  reload?: boolean;
  /**
   * 세대 식별자를 직접 준다. 같은 값이면 같은 그래프를 재사용하고 다른 값이면 새로
   * 인스턴스화한다. `reload` 가 매번 새 값을 만드는 편의 형태다.
   */
  generation?: string | number;
}

let generationCounter = 0;
let hooksRegistered = false;
/** 세대 없이 로드된 엔트리 파일의 바이트 지문. 재로드 없는 두 번째 로드에서 대조한다. */
const loadedBytes = new Map<string, string>();

function fileRev(abs: string): string {
  return sha(readFileSync(abs, 'utf8'), 32);
}

function registerHooks(): void {
  if (hooksRegistered) return;
  const register = (nodeModule as { register?: (spec: string, parent: string) => void }).register;
  if (typeof register !== 'function') {
    throw new Error('프로세스 내 재로드는 Node 20.6 이상이 필요하다 — module.register 가 없다.');
  }
  register('./loader-hooks.js', import.meta.url);
  hooksRegistered = true;
}

function generationOf(opts?: LoadOptions): string | undefined {
  if (opts?.generation != null) return String(opts.generation);
  if (opts?.reload) return String(++generationCounter);
  return undefined;
}

/**
 * 엔트리 파일을 import 한다. 세대가 있으면 URL 에 세대 토큰을 실어 보내고, 로더 훅이 그
 * 토큰을 `cwd` 아래 모든 상대 import 로 전파한다 — 최상위 룰 파일에만 쿼리를 붙이면 그
 * 룰이 import 한 checker 는 원래 URL 그대로 캐시된 export 를 쓰기 때문이다.
 * 세대가 없으면 바이트 지문을 기록하고, 이미 기록된 파일의 바이트가 다르면 던진다.
 */
async function importEntry<T>(cwd: string, abs: string, gen: string | undefined): Promise<T> {
  const url = new URL(pathToFileURL(abs).href);
  if (gen != null) {
    registerHooks();
    url.searchParams.set(GENERATION_PARAM, gen);
    // Node 의 해석기는 file: URL 을 realpath 로 정규화한다. 루트도 같은 형태여야
    // 훅의 "루트 아래인가" 검사가 심볼릭 링크(macOS 의 /tmp 등)에서 어긋나지 않는다.
    url.searchParams.set(ROOT_PARAM, realpathSync(resolve(cwd)));
  } else {
    const rev = fileRev(abs);
    const prev = loadedBytes.get(abs);
    if (prev != null && prev !== rev) throw new StaleModuleGraphError([abs]);
    loadedBytes.set(abs, rev);
  }
  return (await import(url.href)) as T;
}

export async function loadConfig(cwd: string, opts?: LoadOptions): Promise<ResolvedConfig> {
  const gen = generationOf(opts);
  for (const name of CONFIG_NAMES) {
    const p = join(cwd, name);
    if (!existsSync(p)) continue;
    const mod = await importEntry<{ default?: GateConfig }>(cwd, p, gen);
    return resolveConfig(mod.default ?? {});
  }
  return resolveConfig();
}

export async function loadRules(cwd: string, config: GateConfig, opts?: LoadOptions): Promise<RuleSpec[]> {
  const gen = generationOf(opts);
  const patterns = config.rules ?? DEFAULT_CONFIG.rules;
  const missing: MissingRule[] = [];

  // 리터럴 경로는 걷기 결과에 기대지 않고 직접 확인한다 — 걷기가 건너뛰는 디렉토리
  // 아래를 가리켜도 선언은 선언이고, 없으면 없다고 말해야 한다.
  const candidates = new Set(walk(cwd).filter((p) => matches(p, patterns)));
  for (const p of patterns.filter(isLiteralPath)) {
    const rel = p.replace(/^\.\//, '');
    if (existsSync(resolve(cwd, rel))) candidates.add(rel);
    else missing.push({ kind: 'path', ref: p, reason: '파일이 없다' });
  }

  const out: RuleSpec[] = [];
  const seen = new Set<string>();
  const specsBySource = new Map<string, number>();
  for (const rel of [...candidates].sort()) {
    const abs = resolve(cwd, rel);
    const mod = await importEntry<Record<string, unknown>>(cwd, abs, gen);
    const specs = [mod.default, ...Object.values(mod)].filter(isRuleSpec);
    specsBySource.set(rel, specs.length);
    for (const s of specs) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push({ ...s, source: rel });
    }
  }

  for (const p of patterns.filter(isLiteralPath)) {
    const rel = p.replace(/^\.\//, '');
    if (specsBySource.get(rel) === 0) {
      missing.push({ kind: 'path', ref: p, reason: '파일은 있으나 `rule()` 로 만든 export 가 없다' });
    }
  }
  for (const id of config.required ?? []) {
    if (!seen.has(id)) missing.push({ kind: 'id', ref: id, reason: '등록된 룰 중에 없다' });
  }
  if (missing.length) throw new RuleRegistryError(missing);

  // 레포 면제는 등록의 마지막 단계다 — 룰이 자기 것으로 들고 온 마스크 위에 얹힌다.
  return applyMaskFile(out, loadMaskFile(cwd, config.masks));
}
