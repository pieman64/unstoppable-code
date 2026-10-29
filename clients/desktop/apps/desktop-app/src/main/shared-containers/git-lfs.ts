import { open } from 'node:fs/promises';

export const MAX_GIT_ATTRIBUTES_INSPECTION_BYTES = 1024 * 1024;

export function bufferContainsLfsAttributes(buffer: Buffer): boolean {
  if (buffer.byteLength > MAX_GIT_ATTRIBUTES_INSPECTION_BYTES) return true;
  return buffer
    .toString('utf8')
    .split(/\r?\n/)
    .some((line) => {
      const trimmed = line.trimStart();
      return (
        !trimmed.startsWith('#') &&
        /(?:^|\s)filter\s*=\s*lfs(?:\s|$)/i.test(line)
      );
    });
}

export async function fileContainsLfsAttributes(
  path: string,
): Promise<boolean> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_GIT_ATTRIBUTES_INSPECTION_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return bufferContainsLfsAttributes(buffer.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}
