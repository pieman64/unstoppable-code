import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { runOpenCodeTurn } from '../turn-driver';

async function main(): Promise<void> {
  const file = process.argv[2];
  const agent = process.argv[3];
  if (!file || !agent)
    throw new Error('Expected delegated turn input and agent');
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  const input = z
    .object({
      cwd: z.string(),
      profileDir: z.string(),
      capabilityContext: z.unknown(),
      sessionId: z.string().optional(),
    })
    .parse(value);
  const result = await runOpenCodeTurn(
    {
      ...input,
      executable: process.execPath,
      prefix: [agent],
      env: process.env,
      rawModelId: 'fixture/model',
      prompt: 'Hello',
      signal: AbortSignal.timeout(10000),
    },
    {
      authorize: () => Promise.resolve({ decision: 'deny' }),
      emit: () => undefined,
    },
  );
  process.stdout.write(JSON.stringify(result));
}

void main();
