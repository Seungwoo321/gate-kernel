/**
 * 대상 표준 라이브러리.
 *
 * 여기 있는 것들은 **커널이 아는 목록이 아니다.** 전부 `Subject`(= 함수)를 돌려주는
 * 헬퍼일 뿐이고, 커널은 그 함수를 부를 줄만 안다. 그래서 여기 없는 대상이 필요하면
 * 커널을 고치지 않고 게이트 파일에서 함수를 그냥 쓰면 된다:
 *
 * ```js
 * subject: async (env) => ({ files: await 우리사내API.문서목록(), label: 'docs-api' })
 * ```
 *
 * `expect` 매처가 라이브러리이지 언어가 아닌 것과 같은 자리다.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve as resolvePath, sep } from 'node:path';
import type { Subject, SliceFile, TreeRef } from './types.ts';
import { filter } from './glob.ts';
import * as git from './subjects/git.ts';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.gate']);

function walk(root: string, acc: string[] = [], base = root): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, acc, base);
    else acc.push(relative(base, full).split(sep).join('/'));
  }
  return acc;
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const arr = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v]);

/** 작업 트리의 파일 집합. 문서 정합처럼 코퍼스 전체를 보는 게이트의 기본형. */
export const tree =
  (include: string | string[], opts: { root?: string; exclude?: string[] } = {}): Subject =>
  (env) => {
    const root = resolvePath(env.cwd, opts.root ?? '.');
    const picked = filter(walk(root), arr(include), opts.exclude);
    return {
      label: 'tree',
      meta: { root },
      files: picked.map<SliceFile>((p) => ({ path: p, text: readText(join(root, p)) })),
    };
  };

/**
 * 변경분. 코드 게이트의 기본형.
 * `granularity: 'addedLines'` 는 "추가된 줄만 본다" — 기존 코드의 부채를 새 변경에
 * 뒤집어씌우지 않는 게이트(예: 수정의 일반성 검사)에 필요하다.
 */
export const diff =
  (
    opts: {
      base?: string | 'auto';
      include?: string[];
      exclude?: string[];
      granularity?: 'file' | 'addedLines';
    } = {},
  ): Subject =>
  (env) => {
    if (!git.isRepo(env.cwd)) throw new Error('subject.diff 는 git 레포에서만 쓸 수 있다');
    const base = git.resolveBase(env.cwd, opts.base ?? 'auto');
    const changed = filter(git.changedFiles(env.cwd, base), opts.include, opts.exclude);
    return {
      label: 'diff',
      meta: { base, granularity: opts.granularity ?? 'file' },
      data: base,
      files: changed.map<SliceFile>((p) => {
        const f: SliceFile = { path: p, text: readText(join(env.cwd, p)) };
        if (opts.granularity === 'addedLines') f.addedLines = git.addedLines(env.cwd, base, p);
        return f;
      }),
    };
  };

/**
 * 두 트리의 대조. 고정 원본 대비 표류, 크로스 레포 정합, 상위 스킬 사본 확인.
 * `left` 가 기준, `right` 가 검사 대상이다.
 */
export const pair =
  (
    left: TreeRef,
    right: TreeRef,
    include: string | string[],
    opts: { exclude?: string[] } = {},
  ): Subject =>
  (env) => {
    const rightRoot = resolvePath(env.cwd, right.root ?? '.');
    const leftRoot = resolvePath(env.cwd, left.root ?? '.');
    const rightPaths = right.ref ? git.listTree(rightRoot, right.ref) : walk(rightRoot);
    const picked = filter(rightPaths, arr(include), opts.exclude);
    return {
      label: 'pair',
      meta: { left, right },
      data: [left, right],
      files: picked.map<SliceFile>((p) => ({
        path: p,
        text: right.ref ? (git.showFile(rightRoot, right.ref, p) ?? '') : readText(join(rightRoot, p)),
        counterpart: left.ref
          ? git.showFile(leftRoot, left.ref, p)
          : existsSync(join(leftRoot, p))
            ? readText(join(leftRoot, p))
            : null,
      })),
    };
  };

/**
 * 외부 명령의 산출. 커밋된 베이스라인 파일 대신 **라이브 측정**을 쓰는 델타 게이트,
 * 그리고 산출물을 지우고 다시 만들어 대조하는 재실행 게이트가 여기 붙는다.
 */
export const command =
  (
    run: string,
    opts: {
      args?: string[];
      cwd?: string;
      parse?: 'json' | 'lines' | 'raw';
      /** 같은 명령을 다른 리비전에서 한 번 더 돌려 델타를 만든다. */
      baselineRef?: string;
    } = {},
  ): Subject =>
  (env) => {
    const exec = (ref?: string): unknown => {
      const cwd = resolvePath(env.cwd, opts.cwd ?? '.');
      const out = execFileSync(run, opts.args ?? [], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...(ref ? { GATE_BASELINE_REF: ref } : {}) },
      });
      if (opts.parse === 'json') return JSON.parse(out);
      if (opts.parse === 'lines') return out.split('\n').filter(Boolean);
      return out;
    };
    // 커밋된 베이스라인 파일을 두지 않는다 — 파일은 갱신을 잊으면 조용히 거짓이 된다.
    // 대신 같은 명령을 기준 리비전에서 한 번 더 측정한다.
    const baseline = opts.baselineRef ? exec(git.resolveBase(env.cwd, opts.baselineRef)) : null;
    return {
      label: 'command',
      meta: { run, args: opts.args ?? [], baselineRef: opts.baselineRef ?? null },
      data: { current: exec(), baseline },
    };
  };

/** 파일이 아닌 대상. provider 는 `gate.config` 의 `providers` 에 등록한다. */
export const external =
  (provider: string, params?: Record<string, unknown>): Subject =>
  async (env) => {
    const p = env.config.providers?.[provider];
    if (!p) {
      throw new Error(
        `external provider '${provider}' 가 gate.config 에 등록돼 있지 않다 — 판정 불가는 통과가 아니다`,
      );
    }
    const got = await p.resolve(params ?? {});
    return { label: 'external', files: got.files, data: got.data, meta: { provider, ...got.meta } };
  };

/** 룰 레지스트리 자신. 메타 게이트를 일급으로 만든다. */
export const rules = (): Subject => (env) => ({
  label: 'rules',
  data: env.registry.map((r) => ({
    id: r.id,
    criterion: r.criterion,
    lane: r.lane,
    validates: r.validates ?? [],
    source: r.source ?? null,
    tags: r.tags ?? [],
  })),
});

/**
 * 여러 축을 한 대상으로 합친다. 판정식이 축을 **함께** 봐야 성립할 때만 쓴다.
 *
 * ```js
 * subject.all({ pin: subject.diff({ include: ['pins/*.json'] }),
 *               consent: subject.external('issues', { label: 'pin-change' }) })
 * ```
 *
 * 합친 축의 파일에는 `source` 가 붙고, 축별 데이터는 `ctx.slice.data[<as>]` 로 온다.
 * 축을 나눠도 각각 판정이 성립한다면 나누는 쪽이 맞다 — 합치면 슬라이스가 커지고,
 * 큰 슬라이스는 판정 비용과 오판을 같이 키운다.
 */
export const all =
  (parts: Record<string, Subject>): Subject =>
  async (env) => {
    const files: SliceFile[] = [];
    const data: Record<string, unknown> = {};
    const meta: Record<string, unknown> = {};
    for (const [as, part] of Object.entries(parts)) {
      const body = await part(env);
      // 축 이름을 파일에 새긴다 — 합친 뒤에도 "이건 어느 축에서 왔나" 가 판정식에
      // 필요하고, 같은 경로가 두 축에 있을 때 구별할 방법이 이것뿐이다.
      for (const f of body.files ?? []) files.push({ ...f, source: as });
      data[as] = body.data ?? null;
      meta[as] = body.meta ?? {};
    }
    return { label: 'all', files, data, meta };
  };

export const subject = { tree, diff, pair, command, external, rules, all };
