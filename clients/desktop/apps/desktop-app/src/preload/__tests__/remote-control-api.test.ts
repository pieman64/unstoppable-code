jest.mock('electron', () => ({ ipcRenderer: {} }));

import {
  IPC_CHANNELS,
  REMOTE_UPLOAD_MAX_BYTES,
} from '@canopy/desktop-shared/types';
import { uploadFilesToRemote } from '../api/remote-control-api';

function fileOf(name: string, text: string): File {
  return new File([text], name);
}

describe('uploadFilesToRemote', () => {
  it('uploads files one at a time and returns their paths there', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: Array<{ fileName: string; size: number }> = [];
    const invoke = jest.fn(
      async (channel: string, request: unknown): Promise<unknown> => {
        expect(channel).toBe(IPC_CHANNELS.remoteControlUpload);
        if (
          typeof request !== 'object' ||
          request === null ||
          !('fileName' in request) ||
          typeof request.fileName !== 'string' ||
          !('bytes' in request) ||
          !(request.bytes instanceof Uint8Array)
        ) {
          throw new Error('Unexpected upload request.');
        }
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        calls.push({ fileName: request.fileName, size: request.bytes.length });
        return `/remote/${request.fileName}`;
      },
    );

    const paths = await uploadFilesToRemote({ invoke }, [
      fileOf('a.txt', 'one'),
      fileOf('dir/b.txt', 'three'),
    ]);

    expect(maxInFlight).toBe(1);
    expect(calls).toEqual([
      { fileName: 'a.txt', size: 3 },
      // A name never carries a path separator to the other computer.
      { fileName: 'dir_b.txt', size: 5 },
    ]);
    expect(paths).toEqual(['/remote/a.txt', '/remote/dir_b.txt']);
  });

  it('sends nothing when any file is over the limit', async () => {
    const invoke = jest.fn(() => Promise.resolve('/remote/x'));
    const big = fileOf('big.bin', '');
    Object.defineProperty(big, 'size', { value: REMOTE_UPLOAD_MAX_BYTES + 1 });

    await expect(
      uploadFilesToRemote({ invoke }, [fileOf('small.txt', 'ok'), big]),
    ).rejects.toThrow('too large');
    expect(invoke).not.toHaveBeenCalled();
  });
});
