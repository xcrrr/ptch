import { useStdout } from 'ink';
import { useEffect, useState } from 'react';

export interface TerminalSize {
  columns: number;
  rows: number;
}

const DEFAULT_SIZE: TerminalSize = { columns: 80, rows: 24 };

function readSize(stream: NodeJS.WriteStream): TerminalSize {
  const { columns, rows } = stream;
  return {
    columns: typeof columns === 'number' && columns > 0 ? columns : DEFAULT_SIZE.columns,
    rows: typeof rows === 'number' && rows > 0 ? rows : DEFAULT_SIZE.rows,
  };
}

/**
 * The terminal's size, updated on resize. Streams that are not terminals report no size, so
 * piped output and tests fall back to 80x24.
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => readSize(stdout));
  useEffect(() => {
    const update = (): void => {
      const next = readSize(stdout);
      setSize((current) =>
        current.columns === next.columns && current.rows === next.rows ? current : next,
      );
    };
    update();
    stdout.on('resize', update);
    return () => {
      stdout.off('resize', update);
    };
  }, [stdout]);
  return size;
}
