import { Box, Text } from 'ink';
import { glyphs, INDENT, theme } from '../theme.js';
import type { WelcomeInfo } from '../transcript.js';
import type { WelcomeProps } from './props.js';

const SEPARATOR = ` ${glyphs.dot} `;

/**
 * Restrained startup header:
 *   ptch 0.1.0
 *   ~/code/project · main · 3 changed
 *   claude-opus-5-5 · ready · PATCH.md
 * The title line is left out under the startup logo, which already shows the name.
 */
export function Welcome({ info, showTitle = true }: WelcomeProps) {
  const workspace = workspaceParts(info);
  return (
    <Box flexDirection="column" paddingLeft={INDENT}>
      {showTitle && (
        <Text>
          <Text bold>ptch</Text>
          <Text dimColor> {info.version}</Text>
        </Text>
      )}
      <Text>
        {info.location}
        {workspace.length > 0 && <Text dimColor>{SEPARATOR + workspace.join(SEPARATOR)}</Text>}
      </Text>
      <Text>
        {info.model}
        <Text dimColor>{SEPARATOR}</Text>
        <Text color={statusColor(info.statusLevel)} dimColor={info.statusLevel === 'ok'}>
          {info.status}
        </Text>
        {info.instructionFiles.length > 0 && (
          <Text dimColor>{SEPARATOR + info.instructionFiles.join(', ')}</Text>
        )}
      </Text>
      {info.notes.map((note, i) => (
        <Text key={i} dimColor>
          {note}
        </Text>
      ))}
    </Box>
  );
}

function workspaceParts(info: WelcomeInfo): string[] {
  if (!info.isGit) return ['not a git repository'];
  const parts: string[] = [];
  if (info.branch) parts.push(info.branch);
  if (info.changedFiles !== null) {
    parts.push(info.changedFiles === 0 ? 'clean' : `${info.changedFiles} changed`);
  }
  return parts;
}

function statusColor(level: WelcomeInfo['statusLevel']): string | undefined {
  if (level === 'warn') return theme.warning;
  if (level === 'error') return theme.danger;
  return undefined;
}
