import { bashTool } from './bash.js';
import { editFileTool } from './edit-file.js';
import { gitDiffTool, gitLogTool, gitStatusTool } from './git-tools.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { listDirectoryTool } from './list-directory.js';
import { presentPlanTool } from './present-plan.js';
import { readFileTool } from './read-file.js';
import type { ToolDefinition } from './types.js';
import { writeFileTool } from './write-file.js';

/**
 * The default tool set in a fixed order (the order is part of the cached prompt prefix).
 * Git tools are always present; in directory mode they return a clear error. present_plan is
 * present in every permission mode, so switching modes never changes the tool list.
 */
export function createDefaultTools(): ToolDefinition[] {
  return [
    readFileTool,
    editFileTool,
    writeFileTool,
    listDirectoryTool,
    globTool,
    grepTool,
    bashTool,
    gitStatusTool,
    gitDiffTool,
    gitLogTool,
    presentPlanTool,
  ] as ToolDefinition[];
}

export {
  bashTool,
  editFileTool,
  gitDiffTool,
  gitLogTool,
  gitStatusTool,
  globTool,
  grepTool,
  listDirectoryTool,
  presentPlanTool,
  readFileTool,
  writeFileTool,
};
