import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REMOTE_UPLOAD_MAX_BYTES } from '@canopy/desktop-shared/types';
import { uploadLocalFiles } from '../client/upload-local-files';
import { MAX_MESSAGE_BYTES } from '../transport/message-codec';

const dirs: string[] = [];

function tempFiles(sizes: number[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'upload-local-files-'));
  dirs.push(dir);
  return sizes.map((size, index) => {
    const path = join(dir, `file-${index}.bin`);
    writeFileSync(path, Buffer.alloc(size, index));
    return path;
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('uploadLocalFiles', () => {
  it('sends files one at a time, in order', async () => {
    const paths = tempFiles([3, 5, 7]);
    let inFlight = 0;
    let maxInFlight = 0;
    const sent: number[] = [];
    const remote = await uploadLocalFiles(paths, async (fileName, bytes) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      sent.push(bytes.byteLength);
      inFlight -= 1;
      return `/remote/${fileName}`;
    });
    expect(maxInFlight).toBe(1);
    expect(sent).toEqual([3, 5, 7]);
    expect(remote).toEqual([
      '/remote/file-0.bin',
      '/remote/file-1.bin',
      '/remote/file-2.bin',
    ]);
  });

  it('refuses a selection with a file over the limit before sending any', async () => {
    const paths = tempFiles([4, 64]);
    const upload = jest.fn(() => Promise.resolve('/remote/file'));
    await expect(uploadLocalFiles(paths, upload, 32)).rejects.toThrow(
      'too large',
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it('keeps the upload limit below the session message limit', () => {
    // One upload is one message: its bytes plus the upload ID and file name.
    expect(REMOTE_UPLOAD_MAX_BYTES + 1024 * 1024).toBeLessThanOrEqual(
      MAX_MESSAGE_BYTES,
    );
  });
});
