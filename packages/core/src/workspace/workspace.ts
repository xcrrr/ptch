import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { detectGitRepo } from '../git/git.js';
import { findGuidanceFiles } from './guidance.js';
import { loadInstructions } from './instructions.js';
import { detectProject } from './project.js';
import type { DetectWorkspaceOptions, WorkspaceInfo } from './types.js';

export type {
  DetectWorkspaceOptions,
  GuidanceFile,
  InstructionFile,
  InstructionSource,
  ProjectInfo,
  WorkspaceInfo,
} from './types.js';
export { detectProject } from './project.js';
export { loadInstructions, MAX_INSTRUCTION_BYTES } from './instructions.js';
export { findGuidanceFiles } from './guidance.js';

/**
 * Detects the repository root, branch and project type for `cwd`. Works without Git
 * (directory mode). Never throws for a missing git binary or a non-repo directory.
 */
export async function detectWorkspace(options: DetectWorkspaceOptions): Promise<WorkspaceInfo> {
  const start = path.resolve(options.cwd);
  const git = await detectGitRepo(start);
  const projectRoot = git?.root ?? start;
  const cwd = git ? await spelledUnder(projectRoot, start) : start;
  const [project, instructions, guidance] = await Promise.all([
    detectProject(projectRoot),
    loadInstructions({
      projectRoot,
      cwd,
      home: options.home,
      userInstructionsPath: options.userInstructionsPath,
    }),
    findGuidanceFiles(projectRoot),
  ]);
  return {
    cwd,
    projectRoot,
    home: options.home,
    platform: options.platform ?? process.platform,
    isGit: git !== null,
    git,
    project,
    instructions,
    guidance,
  };
}

/**
 * `dir` written under `root`'s spelling. Git reports the repository root as a real, long path,
 * while the shell can hand Patch the same directory as a Windows short name
 * (C:\Users\RUNNER~1\...) or through a symlink or junction. Paths are shown and checked relative
 * to the root, so both must be spelled alike. Unchanged when `dir` is not inside `root`.
 */
async function spelledUnder(root: string, dir: string): Promise<string> {
  if (isInside(root, dir)) return dir;
  try {
    const [realRoot, realDir] = await Promise.all([realpath(root), realpath(dir)]);
    if (isInside(realRoot, realDir)) return path.join(root, path.relative(realRoot, realDir));
  } catch {
    // Unreadable: keep the directory as given.
  }
  return dir;
}

function isInside(root: string, dir: string): boolean {
  const relative = path.relative(root, dir);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
