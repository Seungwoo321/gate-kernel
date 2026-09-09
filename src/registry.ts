import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RuleSpec } from './types.ts';
import { isRuleSpec } from './rule.ts';
import { DEFAULT_CONFIG, resolveConfig, type ResolvedConfig, type GateConfig } from './config.ts';
import { matches } from './glob.ts';
import { applyMaskFile, loadMaskFile } from './masks.ts';

const SKIP = new Set(['.git', 'node_modules', 'dist', '.gate']);

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

export async function loadConfig(cwd: string): Promise<ResolvedConfig> {
  for (const name of ['gate.config.mjs', 'gate.config.js', 'gate.config.ts']) {
    const p = join(cwd, name);
    if (!existsSync(p)) continue;
    const mod = (await import(pathToFileURL(p).href)) as { default?: GateConfig };
    return resolveConfig(mod.default ?? {});
  }
  return resolveConfig();
}

export async function loadRules(cwd: string, config: GateConfig): Promise<RuleSpec[]> {
  const patterns = config.rules ?? DEFAULT_CONFIG.rules;
  const candidates = walk(cwd).filter((p) => matches(p, patterns));
  const out: RuleSpec[] = [];
  const seen = new Set<string>();
  for (const rel of candidates.sort()) {
    const abs = resolve(cwd, rel);
    const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
    const specs = [mod.default, ...Object.values(mod)].filter(isRuleSpec);
    for (const s of specs) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push({ ...s, source: rel });
    }
  }
  // 레포 면제는 등록의 마지막 단계다 — 룰이 자기 것으로 들고 온 마스크 위에 얹힌다.
  return applyMaskFile(out, loadMaskFile(cwd, config.masks));
}
