import type * as fs from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, request, type ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CancellationToken } from 'builder-util-runtime';
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor';

// Keep the real updater HTTP executor, checksum transform and filesystem.
// Only its Electron transport is replaced with a loopback Node HTTP request.
jest.mock('electron', () => ({
  session: { fromPartition: (): object => ({}) },
  net: {
    request: (options: object): ClientRequest =>
      request({ ...options, agent: false }),
  },
}));

describe('Windows full-download stream cleanup', () => {
  it.each(['interrupted', 'timeout', 'checksum mismatch', 'complete'])(
    'closes the installer before returning a %s download and permits a retry',
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), 'can-4188-http-'));
      const file = join(directory, 'temp-installer.exe');
      const payload = Buffer.alloc(64 * 1024, 'installer fixture');
      const digest = createHash('sha512').update(payload).digest('base64');
      let interrupt = mode === 'interrupted' || mode === 'timeout';
      const ranges: Array<string | undefined> = [];
      const server = createServer((req, response) => {
        ranges.push(req.headers.range);
        response.writeHead(200, {
          'Content-Length': payload.length,
          'Content-Type': 'application/x-msdos-program',
        });
        if (interrupt) {
          interrupt = false;
          response.write(payload.subarray(0, 1024));
          if (mode === 'interrupted') setTimeout(() => response.destroy(), 20);
        } else response.end(payload);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing fixture address');
      const executor = new ElectronHttpExecutor(undefined);
      const originalErrorHandlers =
        executor.addErrorAndTimeoutHandlers.bind(executor);
      jest
        .spyOn(executor, 'addErrorAndTimeoutHandlers')
        .mockImplementation((request, reject) =>
          originalErrorHandlers(request, reject, 100),
        );
      const actualFs = jest.requireActual<typeof fs>('node:fs');
      const original = actualFs.createWriteStream;
      const streams: fs.WriteStream[] = [];
      const spy = jest
        .spyOn(actualFs, 'createWriteStream')
        .mockImplementation(
          (...args: Parameters<typeof fs.createWriteStream>) => {
            const stream = original(...args);
            streams.push(stream);
            return stream;
          },
        );
      try {
        const download = executor.download(
          new URL(`http://127.0.0.1:${address.port}/installer.exe`),
          file,
          {
            cancellationToken: new CancellationToken(),
            sha512: mode === 'checksum mismatch' ? 'wrong-checksum' : digest,
          },
        );
        if (mode === 'complete') await download;
        else await expect(download).rejects.toThrow();
        expect(streams).toHaveLength(1);
        expect(streams[0].closed).toBe(true);
        await rm(file);
        await executor.download(
          new URL(`http://127.0.0.1:${address.port}/installer.exe`),
          file,
          { cancellationToken: new CancellationToken(), sha512: digest },
        );
        expect(await readFile(file)).toEqual(payload);
        expect(streams.every((stream) => stream.closed)).toBe(true);
        expect(ranges).toEqual([undefined, undefined]);
      } finally {
        spy.mockRestore();
        for (const stream of streams) {
          if (!stream.closed)
            await new Promise<void>((resolve) => {
              stream.once('close', resolve);
              stream.destroy();
            });
        }
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
