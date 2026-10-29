import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { c } from 'tar';
import { readOpenCodeAgentSource } from './opencode-agent-source.mjs';

export async function openCodeConnectionFixture({ holdArchive = false } = {}) {
  const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
  const root = await mkdtemp(
    path.join(tmpdir(), 'opencode-connection-fixture-'),
  );
  await mkdir(path.join(root, 'package/bin'), { recursive: true });
  // Reuse the protocol fixture, including the real host approval handshake.
  const source = await readOpenCodeAgentSource(
    path.join(
      repo,
      'packages/desktop-shared/src/node/opencode/__tests__/fake-agent.mjs',
    ),
  );
  const executable = `#!${process.execPath}
${source}`;
  await writeFile(path.join(root, 'package/bin/opencode'), executable, {
    mode: 0o700,
  });
  await c({ cwd: root, file: path.join(root, 'fixture.tgz'), gzip: true }, [
    'package',
  ]);
  const archive = await readFile(path.join(root, 'fixture.tgz'));
  const pending = new Set();
  let archiveRequests = 0;
  let abortedRequests = 0;
  const server = createServer((_request, response) => {
    archiveRequests++;
    if (!holdArchive) {
      response.end(archive);
      return;
    }
    pending.add(response);
    response.on('close', () => {
      if (!response.writableEnded) abortedRequests++;
      pending.delete(response);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = path.join(repo, '.playwright/opencode-connection-host');
  await mkdir(host, { recursive: true });
  try {
    await build({
      entryPoints: [
        path.join(
          repo,
          'apps/desktop-app/src/renderer/src/hooks/__tests__/fixtures/opencode-connection.tsx',
        ),
      ],
      outfile: path.join(host, 'fixture.js'),
      bundle: true,
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      alias: {
        '@': path.join(repo, 'apps/desktop-app/src/renderer/src'),
        '@canopy/protocol': path.join(repo, 'packages/protocol/src'),
        '@canopy/desktop-shared': path.join(
          repo,
          'packages/desktop-shared/src',
        ),
        react: path.join(repo, 'node_modules/react'),
        'react-dom': path.join(repo, 'node_modules/react-dom'),
      },
    });
    await writeFile(
      path.join(host, 'index.html'),
      '<!doctype html><div id="root"></div><script src="./fixture.js"></script>',
    );
  } catch (error) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    archiveRequests: () => archiveRequests,
    abortedRequests: () => abortedRequests,
    releaseArchive() {
      for (const response of pending) response.end(archive);
      pending.clear();
    },
    url: pathToFileURL(path.join(host, 'index.html')).href,
    env: {
      XDG_DATA_HOME: path.join(root, 'native-data'),
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-desktop-opencode-harness': true,
      }),
      CANOPY_E2E_OPENCODE_RUNTIME: JSON.stringify({
        url: `http://127.0.0.1:${server.address().port}/opencode.tgz`,
        integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
        executableSha256: createHash('sha256').update(executable).digest('hex'),
        archiveBytes: archive.length,
      }),
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}
