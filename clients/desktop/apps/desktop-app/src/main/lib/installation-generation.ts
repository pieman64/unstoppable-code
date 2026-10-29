import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomically } from './atomic-file';
import { getInstallationGenerationFilePath } from './paths';

interface InstallationGeneration {
  version: 1;
  generation: number;
  deviceId?: string;
}
let queue: Promise<unknown> = Promise.resolve();

/**
 * The server stores the generation in a 32-bit signed column and rejects
 * anything above this, so a fallback has to fit here or setup fails with a 400.
 */
const MAX_INSTALLATION_GENERATION = 2147483647;
const GENERATION_EPOCH_MS = Date.UTC(2026, 0, 1);

/**
 * A generation for a device whose recorded one is unreadable. Seconds — not
 * milliseconds — since 2026: monotonic across corruptions, far above anything
 * an install counted up to, and inside the server's range for the next sixty
 * years.
 */
function freshGeneration(): number {
  const seconds = Math.floor((Date.now() - GENERATION_EPOCH_MS) / 1000);
  return Math.min(MAX_INSTALLATION_GENERATION, Math.max(1, seconds));
}

async function updateGeneration(
  deviceId: string | undefined,
  bump: boolean,
  minimum = 0,
): Promise<number> {
  const file = getInstallationGenerationFilePath();
  let current: InstallationGeneration = { version: 1, generation: 0 };
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value) ||
      value.version !== 1 ||
      !('generation' in value) ||
      typeof value.generation !== 'number' ||
      !Number.isSafeInteger(value.generation) ||
      value.generation < 0 ||
      // A persisted value the server could never accept is unusable content,
      // not a generation this device counted to. Treating it as corrupt mints a
      // fresh one; letting it through only to fail the ceiling check later
      // would make setup impossible until the file is deleted by hand.
      value.generation > MAX_INSTALLATION_GENERATION
    ) {
      throw new Error('Invalid installation generation');
    }
    current = {
      version: 1,
      generation: value.generation,
      deviceId:
        'deviceId' in value && typeof value.deviceId === 'string'
          ? value.deviceId
          : undefined,
    };
  } catch (error) {
    const missing =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT';
    if (!missing) {
      // A read that failed for an environmental reason — permissions, a bad
      // disk — is not something to paper over: fail and let it be seen.
      if (typeof error === 'object' && error !== null && 'code' in error)
        throw error;
      // Corrupt or schema-invalid content is different. Rethrowing makes
      // setup impossible until someone deletes the file by hand, and nothing
      // in the app says so. Starting again at zero is not the answer either:
      // the server may already hold an instance recorded under generation
      // zero for this device, and the claim would collide with it. So take a
      // generation this device demonstrably has not used before.
      current = { version: 1, generation: freshGeneration() };
    }
  }
  if (
    bump ||
    (deviceId !== undefined &&
      current.deviceId !== undefined &&
      deviceId !== current.deviceId)
  )
    current.generation += 1;
  current.generation = Math.max(current.generation, minimum);
  if (
    !Number.isSafeInteger(current.generation) ||
    current.generation > MAX_INSTALLATION_GENERATION
  )
    throw new Error('Installation generation exhausted');
  if (deviceId !== undefined) current.deviceId = deviceId;
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomically(file, JSON.stringify(current), { mode: 0o600 });
  return current.generation;
}
function enqueue(
  deviceId: string | undefined,
  bump: boolean,
  minimum = 0,
): Promise<number> {
  const result = queue.then(() => updateGeneration(deviceId, bump, minimum));
  queue = result.catch((): void => {});
  return result;
}
export function readInstallationGeneration(deviceId: string): Promise<number> {
  return enqueue(deviceId, false);
}
export function bumpInstallationGeneration(minimum = 0): Promise<number> {
  return enqueue(undefined, true, minimum);
}
