import { describeError } from '@patch/core';
import { runCli } from './cli.js';

function fatal(error: unknown): void {
  const friendly = describeError(error);
  process.stderr.write(`\nPatch hit an unexpected error: ${friendly.title}\n`);
  if (friendly.hint) process.stderr.write(`${friendly.hint}\n`);
}

process.on('unhandledRejection', (reason) => {
  fatal(reason);
  process.exit(1);
});
process.on('uncaughtException', (error) => {
  fatal(error);
  process.exit(1);
});

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  fatal(error);
  process.exitCode = 1;
}
