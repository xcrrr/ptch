#!/usr/bin/env node
// Packs the built CLI into release/ptch-<version>.tgz and writes release/SHA256SUMS.
//
//   pnpm build && pnpm pack:cli          # or: node scripts/release-pack.mjs
//   node scripts/release-pack.mjs --expect-version 0.1.0   # fail unless the CLI has this version
//
// The tarball holds the bundled CLI (apps/cli/dist), its package.json without workspace-only
// development dependencies, the README and the license. Install it with
// `npm install --global ./ptch-<version>.tgz`. Nothing is published anywhere.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : (args[i + 1] ?? '');
};

const cliDir = join(root, 'apps', 'cli');
const pkg = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8'));
const expected = flag('--expect-version');
if (expected !== undefined && expected.replace(/^v/, '') !== pkg.version) {
  console.error(
    `The CLI is version ${pkg.version}, but ${expected} was expected. Bump apps/cli/package.json first.`,
  );
  process.exit(1);
}
if (!existsSync(join(cliDir, 'dist', 'main.js'))) {
  console.error('apps/cli/dist/main.js is missing. Run "pnpm build" first.');
  process.exit(1);
}

const out = join(root, 'release');
const stage = join(out, 'stage', 'package');
rmSync(join(out, 'stage'), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(cliDir, 'dist'), join(stage, 'dist'), { recursive: true });
copyFileSync(join(root, 'README.md'), join(stage, 'README.md'));
copyFileSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));

const publishable = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  author: pkg.author,
  repository: pkg.repository,
  homepage: pkg.homepage,
  bugs: pkg.bugs,
  type: pkg.type,
  bin: pkg.bin,
  files: ['dist', 'README.md', 'LICENSE'],
  engines: pkg.engines,
  keywords: pkg.keywords,
  dependencies: pkg.dependencies,
};
writeFileSync(join(stage, 'package.json'), `${JSON.stringify(publishable, null, 2)}\n`);

// On Windows npm is a .cmd file, which Node can only start through a shell; the command line has
// no user input in it, so it is passed as one string.
const packed =
  process.platform === 'win32'
    ? spawnSync('npm pack --silent --ignore-scripts', { cwd: stage, encoding: 'utf8', shell: true })
    : spawnSync('npm', ['pack', '--silent', '--ignore-scripts'], { cwd: stage, encoding: 'utf8' });
if (packed.status !== 0) {
  console.error(packed.stderr || packed.stdout);
  process.exit(packed.status ?? 1);
}
const produced = packed.stdout.trim().split('\n').at(-1)?.trim();
const tarball = `ptch-${pkg.version}.tgz`;
rmSync(join(out, tarball), { force: true });
renameSync(join(stage, produced), join(out, tarball));
rmSync(join(out, 'stage'), { recursive: true, force: true });

const sha = createHash('sha256')
  .update(readFileSync(join(out, tarball)))
  .digest('hex');
writeFileSync(join(out, 'SHA256SUMS'), `${sha}  ${tarball}\n`);
console.log(`${join('release', tarball)}\nsha256 ${sha}`);
