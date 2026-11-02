import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Golden files for the code-graph behavior capture (CAN-5064). Each family
 * writes one JSON document under `goldens/`. Comparison is semantic (parsed
 * JSON, so formatting tools may reflow the files) and order-sensitive (object
 * key order and array order are both part of the captured behavior).
 *
 * Re-record only for an intended behavior change:
 * `RECORD_CODE_GRAPH_GOLDEN=1 pnpm test code-graph-golden`.
 */
export const CODE_GRAPH_GOLDEN_DIRECTORY = path.join(__dirname, 'goldens');

export function isRecordingCodeGraphGolden(): boolean {
  return process.env.RECORD_CODE_GRAPH_GOLDEN === '1';
}

function canonicalText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function goldenPath(name: string): string {
  return path.join(CODE_GRAPH_GOLDEN_DIRECTORY, `${name}.json`);
}

/**
 * Compares `value` with the recorded golden `name`, or records it when
 * `RECORD_CODE_GRAPH_GOLDEN=1`. A missing golden always fails outside
 * recording, so a renamed family cannot pass vacuously.
 */
export function expectCodeGraphGolden(name: string, value: unknown): void {
  const file = goldenPath(name);
  const actualText = canonicalText(value);
  if (isRecordingCodeGraphGolden()) {
    mkdirSync(CODE_GRAPH_GOLDEN_DIRECTORY, { recursive: true });
    writeFileSync(file, actualText, 'utf8');
    return;
  }
  if (!existsSync(file)) {
    throw new Error(
      `Missing code-graph golden "${name}". Record it with RECORD_CODE_GRAPH_GOLDEN=1.`,
    );
  }
  const expected: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const actual: unknown = JSON.parse(actualText);
  // Structural equality first, for a readable diff; then the canonical text,
  // which also pins key order.
  expect(actual).toEqual(expected);
  expect(actualText).toBe(canonicalText(expected));
}
