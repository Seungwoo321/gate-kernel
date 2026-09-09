import { execFileSync } from 'node:child_process';

export interface GitOpts {
  cwd: string;
}

function git(args: string[], { cwd }: GitOpts): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function isRepo(cwd: string): boolean {
  try {
    git(['rev-parse', '--git-dir'], { cwd });
    return true;
  } catch {
    return false;
  }
}

export function head(cwd: string): string {
  return git(['rev-parse', 'HEAD'], { cwd }).trim();
}

/**
 * diff base 해소. `'auto'` 는 "이 브랜치가 갈라져 나온 지점" 을 찾는다.
 * 기본 브랜치와의 merge-base 를 쓰는 이유는, HEAD~1 을 쓰면 커밋을 쪼갤수록
 * 게이트가 보는 범위가 줄어들어 **쪼개기가 우회로**가 되기 때문이다.
 */
export function resolveBase(cwd: string, base?: string | 'auto'): string {
  if (base && base !== 'auto') return base;
  for (const candidate of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
    try {
      const ref = git(['rev-parse', '--verify', '--quiet', candidate], { cwd }).trim();
      if (!ref) continue;
      const mb = git(['merge-base', 'HEAD', ref], { cwd }).trim();
      if (mb && mb !== head(cwd)) return mb;
    } catch {
      /* 다음 후보 */
    }
  }
  // 갈라진 지점이 없으면 워킹트리 vs HEAD 를 본다.
  return 'HEAD';
}

export function changedFiles(cwd: string, base: string): string[] {
  const out = git(['diff', '--name-only', '--diff-filter=ACMR', base, '--'], { cwd });
  const staged = git(['diff', '--name-only', '--diff-filter=ACMR', '--cached'], { cwd });
  const unstaged = git(['diff', '--name-only', '--diff-filter=ACMR'], { cwd });
  const set = new Set(
    [...out.split('\n'), ...staged.split('\n'), ...unstaged.split('\n')]
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return [...set].sort();
}

/** 파일별로 추가된 줄 번호(1-based, 새 파일 기준). */
export function addedLines(cwd: string, base: string, file: string): number[] {
  const patch = git(['diff', '-U0', base, '--', file], { cwd });
  const lines: number[] = [];
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
  for (const l of patch.split('\n')) {
    const m = hunk.exec(l);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i += 1) lines.push(start + i);
  }
  return lines;
}

export function showFile(cwd: string, ref: string, file: string): string | null {
  try {
    return git(['show', `${ref}:${file}`], { cwd });
  } catch {
    return null;
  }
}

export function listTree(cwd: string, ref: string): string[] {
  return git(['ls-tree', '-r', '--name-only', ref], { cwd })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}
