/**
 * 최소 글롭. `**`, `*`, `?`, `{a,b}`, `[abc]` 를 지원한다.
 * 런타임 의존성을 0 으로 두기 위해 직접 구현했다 — 프레임워크가 소비자의 의존성
 * 트리를 오염시키면 도입 비용이 게이트 작성 비용보다 커진다.
 */
function toRegex(pattern: string): RegExp {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '*') {
      const isGlobstar = pattern[i + 1] === '*';
      if (isGlobstar) {
        const after = pattern[i + 2];
        if (after === '/') {
          out += '(?:.*/)?';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        out += '\\{';
        i += 1;
        continue;
      }
      const alts = pattern.slice(i + 1, end).split(',');
      out += `(?:${alts.map((a) => toRegex(a).source.replace(/^\^|\$$/g, '')).join('|')})`;
      i = end + 1;
      continue;
    }
    if (c === '[') {
      const end = pattern.indexOf(']', i);
      if (end !== -1) {
        out += pattern.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

const cache = new Map<string, RegExp>();

export function matches(path: string, patterns: string | string[]): boolean {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  const normalized = path.replace(/^\.\//, '');
  for (const p of list) {
    let re = cache.get(p);
    if (!re) {
      re = toRegex(p);
      cache.set(p, re);
    }
    if (re.test(normalized)) return true;
  }
  return false;
}

export function filter(paths: string[], include?: string[], exclude?: string[]): string[] {
  return paths.filter(
    (p) =>
      (!include || include.length === 0 || matches(p, include)) &&
      (!exclude || exclude.length === 0 || !matches(p, exclude)),
  );
}

/**
 * 분류 태그 매칭. 태그는 `docs/terminology` 처럼 `/` 로 깊이를 준 경로형 문자열이고,
 * 스위트의 include/exclude 는 그 경로에 대한 글롭이다.
 *
 * 순수 글롭과 두 군데 다르다 — 둘 다 분류 경로에서만 자연스러운 규칙이다:
 * - `docs` 는 `docs/terminology` 도 덮는다. 상위 마디를 적었으면 그 아래 전부를 뜻한다.
 * - `docs/**` 는 `docs` 자신도 덮는다. 상위 마디만 단 게이트가 빠지면 조용한 누락이 된다.
 * 직계 자식만 원하면 `docs/*` 를 쓴다 — 이건 확장 없이 글롭 그대로 동작한다.
 */
export function matchesTag(tag: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (matches(tag, p)) return true;
    if (!p.includes('*') && matches(tag, `${p}/**`)) return true;
    if (p.endsWith('/**') && tag === p.slice(0, -3)) return true;
  }
  return false;
}
