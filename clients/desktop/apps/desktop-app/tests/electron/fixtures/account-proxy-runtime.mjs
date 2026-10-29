import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { c } from 'tar';

const FAKE_PROXY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fake-account-proxy.mjs',
);

/**
 * A CLIProxyAPI release for "Run on this device" (CAN-4023), served from
 * loopback. Its `cli-proxy-api` reads the config the app writes and runs the
 * fake proxy on that port with that management key and account order,
 * starting with no accounts; a browser sign-in through it adds one.
 */
export async function accountProxyRuntimeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'account-proxy-runtime-'));
  const program = `
const fs = require('node:fs');
const configPath = process.argv[process.argv.indexOf('--config') + 1];
const config = fs.readFileSync(configPath, 'utf8');
const scalar = (key) => JSON.parse(new RegExp('^\\\\s*' + key + ': (.*)$', 'm').exec(config)[1]);
const port = Number(/^\\s*port: (\\d+)$/m.exec(config)[1]);
const clientKey = JSON.parse(/^\\s*- (".*")$/m.exec(config)[1]);
const strategy = /^\\s*strategy: (".*")$/m.exec(config);
import(${JSON.stringify(pathToFileURL(FAKE_PROXY).href)}).then(({ startFakeAccountProxy }) =>
  startFakeAccountProxy({
    port,
    managementKey: scalar('secret-key'),
    version: '8.0.28',
    state: {
      files: [],
      config: {
        routing: {
          strategy: strategy ? JSON.parse(strategy[1]) : 'round-robin',
          'session-affinity': true,
        },
        access: { 'api-keys': [clientKey] },
      },
    },
  }),
);
process.on('SIGTERM', () => process.exit(0));
`;
  const executable = `#!${process.execPath}\n${program}`;
  await writeFile(path.join(root, 'cli-proxy-api'), executable, {
    mode: 0o700,
  });
  await c({ cwd: root, file: path.join(root, 'release.tgz'), gzip: true }, [
    'cli-proxy-api',
  ]);
  const archive = await readFile(path.join(root, 'release.tgz'));
  const state = { downloads: 0 };
  const server = createServer((_request, response) => {
    state.downloads += 1;
    response.writeHead(200, { 'content-type': 'application/gzip' });
    response.end(archive);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    env: {
      CANOPY_E2E_ACCOUNT_PROXY_RUNTIME: JSON.stringify({
        url: `http://127.0.0.1:${server.address().port}/release.tgz`,
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
