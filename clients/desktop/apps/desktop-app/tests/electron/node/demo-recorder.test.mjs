import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startDemoRecording } from '../demo/demoRecorder.mjs';

test('a same-mode recording removes stale steps before capturing new ones', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'canopy-demo-recorder-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const steps = path.join(dir, 'tour-light-steps');
  await mkdir(steps);
  await writeFile(path.join(steps, '01-old-step.jpg'), 'old');
  await mkdir(path.join(dir, 'tour-dark-steps'));
  await writeFile(path.join(dir, 'tour-dark-steps', '01-dark.jpg'), 'dark');

  const session = {
    on() {},
    async detach() {},
    async send(method) {
      if (method === 'Page.captureScreenshot')
        return { data: Buffer.from('new').toString('base64') };
      return {};
    },
  };
  const page = {
    context: () => ({ newCDPSession: async () => session }),
    evaluate: async (callback) => {
      if (String(callback).includes('window.innerWidth')) {
        return { width: 800, height: 600, devicePixelRatio: 2 };
      }
    },
  };
  const recorder = await startDemoRecording(page, { dir, name: 'tour' });
  assert.deepEqual(await readdir(steps), []);
  assert.equal(
    await readFile(path.join(dir, 'tour-dark-steps', '01-dark.jpg'), 'utf8'),
    'dark',
  );
  await recorder.still('New step');
  assert.deepEqual(await readdir(steps), ['01-new-step.jpg']);
  await assert.rejects(recorder.stop(), /captured no frames/);
});
