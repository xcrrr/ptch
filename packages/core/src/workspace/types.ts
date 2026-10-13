import type { GitRepoInfo } from '../git/git.js';

export interface ProjectInfo {
  /** Detected ecosystems, most significant first: "node", "python", "rust", "go", "java", "ruby", "php", "dotnet", "deno", "make". */
  kinds: string[];
  /** Human label, e.g. "Node.js (pnpm)", "Python (uv)", "Rust (cargo)". Empty string if unknown. */
  label: string;
  /** Package manager / build tool when detectable: pnpm, npm, yarn, bun, uv, poetry, pip, cargo, go, maven, gradle, bundler, composer, dotnet, deno. */
  packageManager?: string;
  /** Project name from the manifest, if any. */
  name?: string;
  /** Script names from package.json (node only), sorted, at most 30. */
  scripts: string[];
  /** Best guess at the test command, e.g. "pnpm test", "pytest", "cargo test", "go test ./...". */
  testCommand?: string;
}

export type InstructionSource = 'PATCH.md' | 'CLAUDE.md' | 'AGENTS.md';

export interface InstructionFile {
  /** Absolute path. */
  path: string;
  /** Display path (relative to cwd, or ~-prefixed). */
  display: string;
  scope: 'user' | 'project';
  source: InstructionSource;
  content: string;
  /** True when the file exceeded the size cap and was cut. */
  truncated: boolean;
}

export interface GuidanceFile {
  /** Path relative to the project root, e.g. "README.md". */
  path: string;
  bytes: number;
}

export interface WorkspaceInfo {
  /** Absolute directory Patch was started in. */
  cwd: string;
  /** Git root, or cwd in directory mode. */
  projectRoot: string;
  home: string;
  platform: NodeJS.Platform;
  isGit: boolean;
  git: GitRepoInfo | null;
  project: ProjectInfo;
  /** Loaded instruction files in precedence order (user first, then project). */
  instructions: InstructionFile[];
  /** Repository guidance files that exist but are not loaded into context (README, CONTRIBUTING...). */
  guidance: GuidanceFile[];
}

export interface DetectWorkspaceOptions {
  cwd: string;
  home: string;
  /** ~/.patch/PATCH.md */
  userInstructionsPath: string;
  platform?: NodeJS.Platform;
}
