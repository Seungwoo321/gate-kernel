/**
 * 프로세스 내 재로드를 위한 ESM 로더 훅(`module.register`).
 *
 * Node 는 모듈을 URL 로 영구 캐시한다. 그래서 같은 프로세스에서 룰 파일을 다시
 * import 하면 디스크가 바뀌어도 옛 인스턴스가 돌아온다. 쿼리 문자열로 URL 을 바꾸면
 * 새 인스턴스가 생기지만, 그 룰이 import 한 헬퍼는 원래 URL 그대로라 옛 export 를
 * 쓴다 — 최상위 파일에만 토큰을 붙이는 것으로는 부족하다.
 *
 * 이 훅은 그 토큰을 **부모에서 자식으로 전파**한다. 부모 URL 에 세대 토큰이 있으면,
 * 해소된 자식이 프로젝트 루트 아래의 로컬 파일일 때 같은 토큰을 붙인다. 그러면 설정·
 * 룰·룰이 부른 헬퍼까지 프로젝트 로컬 서브그래프 전체가 세대 단위로 재인스턴스화된다.
 *
 * `node_modules` 아래와 루트 밖은 건드리지 않는다 — `gate-kernel` 자신을 세대마다
 * 다시 만들면 룰이 서로 다른 `rule()` 인스턴스에서 나와 무의미한 메모리를 먹는다.
 * 토큰이 없는 부모에서는 아무것도 하지 않으므로, 등록돼 있어도 일반 import 에는
 * 영향이 없다.
 */
import { fileURLToPath } from 'node:url';
import { sep } from 'node:path';

export const GENERATION_PARAM = 'gate-gen';
export const ROOT_PARAM = 'gate-root';

interface ResolveContext {
  parentURL?: string;
  conditions: string[];
  importAttributes: Record<string, string>;
}
interface ResolveResult {
  url: string;
  format?: string | null;
  shortCircuit?: boolean;
}
type NextResolve = (specifier: string, context: ResolveContext) => Promise<ResolveResult>;

export async function resolve(
  specifier: string,
  context: ResolveContext,
  next: NextResolve,
): Promise<ResolveResult> {
  const resolved = await next(specifier, context);
  if (!context.parentURL || !resolved.url.startsWith('file:')) return resolved;

  const parent = new URL(context.parentURL);
  const gen = parent.searchParams.get(GENERATION_PARAM);
  const root = parent.searchParams.get(ROOT_PARAM);
  if (gen == null || root == null) return resolved;

  const child = new URL(resolved.url);
  if (child.searchParams.has(GENERATION_PARAM)) return resolved;

  const path = fileURLToPath(child);
  const inRoot = path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
  if (!inRoot || path.includes(`${sep}node_modules${sep}`)) return resolved;

  child.searchParams.set(GENERATION_PARAM, gen);
  child.searchParams.set(ROOT_PARAM, root);
  return { ...resolved, url: child.href };
}
