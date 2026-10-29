// Small, deterministic archive served locally through the production installer.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { c } from 'tar';

export async function cursorRuntimeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'cursor-install-fixture-'));
  await mkdir(path.join(root, 'dist-package'));
  const source = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'cursor-acp-agent.mjs',
  );
  await copyFile(source, path.join(root, 'dist-package/cursor-agent'));
  // Production archives include their own Node runtime. Keep the fixture's
  // hook launcher independent from Electron's development-only Node mode.
  const nodeLauncher = `#!/bin/sh\nexec '${process.execPath.replace(/'/g, `'"'"'`)}' "$@"\n`;
  await writeFile(path.join(root, 'dist-package/node'), nodeLauncher, {
    mode: 0o755,
  });
  await c({ cwd: root, file: path.join(root, 'fixture.tgz'), gzip: true }, [
    'dist-package',
  ]);
  const archive = await readFile(path.join(root, 'fixture.tgz'));
  const digest = (data) => createHash('sha256').update(data).digest('hex');
  const state = { requests: 0, mode: 'normal' };
  const server = createServer((_request, response) => {
    state.requests++;
    response.writeHead(200, { 'content-type': 'application/gzip' });
    if (state.mode === 'slow') {
      response.write(archive.subarray(0, 16));
      return;
    }
    response.end(state.mode === 'corrupt' ? Buffer.from('damaged') : archive);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = {
    CANOPY_E2E_CURSOR_RUNTIME: JSON.stringify({
      url: `http://127.0.0.1:${server.address().port}/cursor.tgz`,
      sha256: digest(archive),
      archiveBytes: archive.length,
      filesSha256: digest(
        JSON.stringify({
          'cursor-agent': digest(await readFile(source)),
          node: digest(nodeLauncher),
        }),
      ),
    }),
  };
  return {
    env,
    state,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}
