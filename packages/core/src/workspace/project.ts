import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { splitLines } from '@patch/shared';
import type { ProjectInfo } from './types.js';

const MAX_SCRIPTS = 30;
/** Manifests larger than this are ignored rather than read (they are never that big in practice). */
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

/** One detected ecosystem. Detectors never throw; unreadable manifests just yield less detail. */
interface Ecosystem {
  kind: string;
  label: string;
  packageManager?: string;
  name?: string;
  testCommand?: string;
  scripts?: string[];
}

/** The project root's entries, read once and shared by every detector. */
class RootListing {
  private constructor(
    readonly root: string,
    private readonly files: Set<string>,
    private readonly dirs: Set<string>,
  ) {}

  static async read(root: string): Promise<RootListing | undefined> {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const files = new Set<string>();
    const dirs = new Set<string>();
    await Promise.all(
      entries.map(async (entry) => {
        let isFile = entry.isFile();
        let isDir = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try {
            const target = await stat(path.join(root, entry.name));
            isFile = target.isFile();
            isDir = target.isDirectory();
          } catch {
            return;
          }
        }
        if (isFile) files.add(entry.name);
        if (isDir) dirs.add(entry.name);
      }),
    );
    return new RootListing(root, files, dirs);
  }

  hasFile(name: string): boolean {
    return this.files.has(name);
  }

  hasDir(name: string): boolean {
    return this.dirs.has(name);
  }

  /** File names matching `pattern`, sorted for deterministic results. */
  filesMatching(pattern: RegExp): string[] {
    return [...this.files].filter((name) => pattern.test(name)).sort();
  }

  /** Text of a root file, or undefined when it is missing, unreadable or implausibly large. */
  async text(name: string): Promise<string | undefined> {
    if (!this.files.has(name)) return undefined;
    const file = path.join(this.root, name);
    try {
      if ((await stat(file)).size > MAX_MANIFEST_BYTES) return undefined;
      return (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
    } catch {
      return undefined;
    }
  }
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string | undefined): JsonObject | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function stringField(object: JsonObject | undefined, key: string): string | undefined {
  const value = object?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Reads `key = "value"` from a `[section]` of a TOML document (a deliberately small subset). */
function tomlString(toml: string, section: string, key: string): string | undefined {
  let current: string | undefined;
  for (const raw of splitLines(toml)) {
    const line = raw.trim();
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?/.exec(line);
    if (header) {
      current = header[1];
      continue;
    }
    if (current !== section) continue;
    const entry = /^([\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
    if (entry?.[1] === key) return entry[2] ?? entry[3];
  }
  return undefined;
}

/** True when a Makefile defines `target` (".PHONY: test" and "test := 1" do not count). */
function definesMakeTarget(makefile: string, target: string): boolean {
  for (const line of splitLines(makefile)) {
    if (/^\s/.test(line) || line.startsWith('#')) continue;
    const rule = /^([^:=#]+?)\s*::?(?!=)/.exec(line);
    if (rule && rule[1].trim().split(/\s+/).includes(target)) return true;
  }
  return false;
}

const NODE_LOCKFILES: ReadonlyArray<readonly [file: string, manager: string]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

const NODE_TEST_COMMANDS: Record<string, string> = {
  npm: 'npm test',
  pnpm: 'pnpm test',
  yarn: 'yarn test',
  // `bun test` is Bun's built-in runner, not the package.json script.
  bun: 'bun run test',
};

/** The script `npm init` generates; it only fails, so it is not a test command. */
const NPM_PLACEHOLDER_TEST = 'Error: no test specified';

function nodePackageManager(manifest: JsonObject | undefined, listing: RootListing): string {
  // "packageManager": "pnpm@9.1.0" (Corepack) is authoritative when present.
  const declared = stringField(manifest, 'packageManager')?.split('@')[0];
  if (declared && declared in NODE_TEST_COMMANDS) return declared;
  return NODE_LOCKFILES.find(([file]) => listing.hasFile(file))?.[1] ?? 'npm';
}

async function detectNode(listing: RootListing): Promise<Ecosystem | undefined> {
  if (!listing.hasFile('package.json')) return undefined;
  const manifest = parseJsonObject(await listing.text('package.json'));
  const packageManager = nodePackageManager(manifest, listing);
  const scriptMap = isJsonObject(manifest?.scripts) ? manifest.scripts : {};
  const test = scriptMap.test;
  const hasTestScript =
    typeof test === 'string' && test.trim() !== '' && !test.includes(NPM_PLACEHOLDER_TEST);
  return {
    kind: 'node',
    label: `Node.js (${packageManager})`,
    packageManager,
    name: stringField(manifest, 'name'),
    scripts: Object.keys(scriptMap).sort().slice(0, MAX_SCRIPTS),
    testCommand: hasTestScript ? NODE_TEST_COMMANDS[packageManager] : undefined,
  };
}

const REQUIREMENTS_FILE = /^requirements.*\.txt$/i;
const PYTEST = /\bpytest\b/;

function pythonPackageManager(listing: RootListing, pyproject: string): string {
  if (listing.hasFile('uv.lock')) return 'uv';
  if (listing.hasFile('poetry.lock')) return 'poetry';
  if (/^\[tool\.poetry\]/m.test(pyproject)) return 'poetry';
  if (/^\[tool\.uv\]/m.test(pyproject)) return 'uv';
  return 'pip';
}

async function usesPytest(
  listing: RootListing,
  pyproject: string,
  requirementFiles: string[],
): Promise<boolean> {
  if (listing.hasFile('pytest.ini') || listing.hasFile('conftest.py')) return true;
  if (listing.hasDir('tests') || PYTEST.test(pyproject)) return true;
  const requirements = await Promise.all(requirementFiles.map((file) => listing.text(file)));
  return requirements.some((text) => text !== undefined && PYTEST.test(text));
}

async function detectPython(listing: RootListing): Promise<Ecosystem | undefined> {
  const requirementFiles = listing.filesMatching(REQUIREMENTS_FILE);
  const hasPyproject = listing.hasFile('pyproject.toml');
  if (!hasPyproject && !listing.hasFile('setup.py') && requirementFiles.length === 0) {
    return undefined;
  }
  const pyproject = (hasPyproject ? await listing.text('pyproject.toml') : undefined) ?? '';
  const packageManager = pythonPackageManager(listing, pyproject);
  let testCommand: string | undefined;
  if (packageManager === 'uv') testCommand = 'uv run pytest';
  else if (packageManager === 'poetry') testCommand = 'poetry run pytest';
  else if (await usesPytest(listing, pyproject, requirementFiles)) testCommand = 'pytest';
  return {
    kind: 'python',
    label: `Python (${packageManager})`,
    packageManager,
    name: tomlString(pyproject, 'project', 'name') ?? tomlString(pyproject, 'tool.poetry', 'name'),
    testCommand,
  };
}

async function detectRust(listing: RootListing): Promise<Ecosystem | undefined> {
  if (!listing.hasFile('Cargo.toml')) return undefined;
  const cargo = (await listing.text('Cargo.toml')) ?? '';
  return {
    kind: 'rust',
    label: 'Rust (cargo)',
    packageManager: 'cargo',
    name: tomlString(cargo, 'package', 'name'),
    testCommand: 'cargo test',
  };
}

async function detectGo(listing: RootListing): Promise<Ecosystem | undefined> {
  if (!listing.hasFile('go.mod')) return undefined;
  const module = /^module\s+"?([^\s"]+)"?/m.exec((await listing.text('go.mod')) ?? '');
  return {
    kind: 'go',
    label: 'Go',
    packageManager: 'go',
    name: module?.[1],
    testCommand: 'go test ./...',
  };
}

const GRADLE_FILES = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];

async function gradleProjectName(listing: RootListing): Promise<string | undefined> {
  for (const file of ['settings.gradle.kts', 'settings.gradle']) {
    const settings = await listing.text(file);
    const match = settings && /rootProject\.name\s*=\s*["']([^"']+)["']/.exec(settings);
    if (match) return match[1];
  }
  return undefined;
}

async function detectJava(listing: RootListing): Promise<Ecosystem | undefined> {
  if (listing.hasFile('pom.xml')) {
    return {
      kind: 'java',
      label: 'Java (Maven)',
      packageManager: 'maven',
      testCommand: listing.hasFile('mvnw') ? './mvnw test' : 'mvn test',
    };
  }
  if (!GRADLE_FILES.some((file) => listing.hasFile(file))) return undefined;
  return {
    kind: 'java',
    label: 'Java (Gradle)',
    packageManager: 'gradle',
    name: await gradleProjectName(listing),
    testCommand: listing.hasFile('gradlew') ? './gradlew test' : 'gradle test',
  };
}

async function detectRuby(listing: RootListing): Promise<Ecosystem | undefined> {
  if (!listing.hasFile('Gemfile')) return undefined;
  return {
    kind: 'ruby',
    label: 'Ruby (Bundler)',
    packageManager: 'bundler',
    testCommand: listing.hasDir('spec') ? 'bundle exec rspec' : 'bundle exec rake test',
  };
}

async function detectPhp(listing: RootListing): Promise<Ecosystem | undefined> {
  if (!listing.hasFile('composer.json')) return undefined;
  const manifest = parseJsonObject(await listing.text('composer.json'));
  const scripts = isJsonObject(manifest?.scripts) ? manifest.scripts : {};
  return {
    kind: 'php',
    label: 'PHP (Composer)',
    packageManager: 'composer',
    name: stringField(manifest, 'name'),
    testCommand: 'test' in scripts ? 'composer test' : 'vendor/bin/phpunit',
  };
}

const DOTNET_SOLUTION = /\.(sln|slnx)$/i;
const DOTNET_PROJECT = /\.(csproj|fsproj|vbproj)$/i;

async function detectDotnet(listing: RootListing): Promise<Ecosystem | undefined> {
  const manifest =
    listing.filesMatching(DOTNET_SOLUTION)[0] ?? listing.filesMatching(DOTNET_PROJECT)[0];
  if (manifest === undefined) return undefined;
  return {
    kind: 'dotnet',
    label: '.NET',
    packageManager: 'dotnet',
    name: path.parse(manifest).name,
    testCommand: 'dotnet test',
  };
}

async function detectDeno(listing: RootListing): Promise<Ecosystem | undefined> {
  const config = ['deno.json', 'deno.jsonc'].find((file) => listing.hasFile(file));
  if (config === undefined) return undefined;
  return {
    kind: 'deno',
    label: 'Deno',
    packageManager: 'deno',
    // deno.jsonc may contain comments; its name is then simply not reported.
    name: stringField(parseJsonObject(await listing.text(config)), 'name'),
    testCommand: 'deno test',
  };
}

async function detectMake(listing: RootListing): Promise<Ecosystem | undefined> {
  const makefile = ['GNUmakefile', 'makefile', 'Makefile'].find((file) => listing.hasFile(file));
  if (makefile === undefined) return undefined;
  const text = (await listing.text(makefile)) ?? '';
  return {
    kind: 'make',
    label: 'Make',
    testCommand: definesMakeTarget(text, 'test') ? 'make test' : undefined,
  };
}

/** In significance order; the first ecosystem with a value wins for each ProjectInfo field. */
const DETECTORS: ReadonlyArray<(listing: RootListing) => Promise<Ecosystem | undefined>> = [
  detectNode,
  detectPython,
  detectRust,
  detectGo,
  detectJava,
  detectRuby,
  detectPhp,
  detectDotnet,
  detectDeno,
  detectMake,
];

/** Detects ecosystems, package manager, scripts, and test command for a project root. */
export async function detectProject(root: string): Promise<ProjectInfo> {
  const listing = await RootListing.read(root);
  if (!listing) return { kinds: [], label: '', scripts: [] };
  const detected = await Promise.all(
    DETECTORS.map((detect) => detect(listing).catch(() => undefined)),
  );
  const ecosystems = detected.filter((e): e is Ecosystem => e !== undefined);
  const first = <K extends keyof Ecosystem>(key: K): Ecosystem[K] | undefined =>
    ecosystems.find((e) => e[key] !== undefined)?.[key];

  const info: ProjectInfo = {
    kinds: ecosystems.map((e) => e.kind),
    label: ecosystems
      .slice(0, 2)
      .map((e) => e.label)
      .join(' + '),
    scripts: ecosystems.find((e) => e.kind === 'node')?.scripts ?? [],
  };
  const packageManager = first('packageManager');
  const name = first('name');
  const testCommand = first('testCommand');
  if (packageManager !== undefined) info.packageManager = packageManager;
  if (name !== undefined) info.name = name;
  if (testCommand !== undefined) info.testCommand = testCommand;
  return info;
}
