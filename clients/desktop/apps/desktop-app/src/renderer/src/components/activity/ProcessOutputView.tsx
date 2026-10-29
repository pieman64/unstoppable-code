import type { JSX } from 'react';
import { AnsiOutput } from './AnsiOutput';

export function ProcessOutputView({
  lines,
}: {
  lines: string[];
}): JSX.Element | null {
  if (lines.length === 0) {
    return null;
  }

  return <AnsiOutput lines={lines} className="max-h-44" />;
}
