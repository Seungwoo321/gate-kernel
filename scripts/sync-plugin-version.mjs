#!/usr/bin/env node
/**
 * Carry the package version into the plugin manifest.
 *
 * The plugin and the npm package are one release: the skills and hooks in
 * `plugin/` do nothing on their own, they drive the `gate` CLI that ships in the
 * package. But they carry two version fields, and release-it only bumps
 * `package.json`. Left alone the manifest keeps advertising whatever version it
 * was written with, so the marketplace states a version that has nothing to do
 * with the CLI the user actually gets.
 *
 * Wired into `.release-it.json` at `after:bump`, so the manifest is rewritten
 * before release-it stages the changeset.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'plugin', '.claude-plugin', 'plugin.json');

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (typeof version !== 'string' || version.length === 0) {
  throw new Error('package.json has no version to propagate');
}

const raw = readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(raw);
if (manifest.version === version) {
  process.stdout.write(`plugin manifest already at ${version}\n`);
  process.exit(0);
}

// Rewrite in place rather than re-serialising the whole object: the manifest is
// hand-formatted and a wholesale JSON.stringify would reflow every line, burying
// the one-line version change in a whole-file diff at every release.
const updated = raw.replace(
  /("version"\s*:\s*)"[^"]*"/,
  (_m, prefix) => `${prefix}${JSON.stringify(version)}`,
);
if (updated === raw) throw new Error(`no version field found in ${manifestPath}`);

writeFileSync(manifestPath, updated);
process.stdout.write(`plugin manifest ${manifest.version} -> ${version}\n`);
