export interface SetupInstruction {
  /** One-line problem statement. */
  title: string;
  /** The exact command to run. */
  command: string;
  /** Short follow-up note. */
  note: string;
}

/** One precise instruction for configuring the Anthropic API key on this platform/shell. */
export function apiKeyInstruction(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): SetupInstruction {
  const title = 'No Anthropic API key found.';
  if (platform === 'win32' && !env.MSYSTEM) {
    return {
      title,
      command: 'setx ANTHROPIC_API_KEY "sk-ant-..."',
      note: 'Then open a new terminal and run ptch again. Alternatively set anthropic.apiKey in ~/.patch/config.json.',
    };
  }
  return {
    title,
    command: 'export ANTHROPIC_API_KEY="sk-ant-..."',
    note: 'Add it to your shell profile to keep it, then run ptch again. Alternatively set anthropic.apiKey in ~/.patch/config.json.',
  };
}
