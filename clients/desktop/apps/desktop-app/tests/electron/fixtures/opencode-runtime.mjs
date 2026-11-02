import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { c } from 'tar';
import { readOpenCodeAgentSource } from './opencode-agent-source.mjs';

export async function opencodeRuntimeFixture({ models = [] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'opencode-runtime-fixture-'));
  await mkdir(path.join(root, 'package', 'bin'), { recursive: true });
  let source = await readOpenCodeAgentSource(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'opencode-acp-agent.mjs',
    ),
  );
  source = source.replace(
    'const presentationModels = [];',
    `const presentationModels = ${JSON.stringify(models)};`,
  );
  const accountsFile = path.join(root, 'accounts.json');
  await writeFile(
    accountsFile,
    JSON.stringify({ providers: [], integrations: [] }),
  );
  source = source.replace(
    '/* account-metadata-fixture */',
    `accounts: async () => JSON.parse(await readFile(${JSON.stringify(accountsFile)}, 'utf8')),`,
  );
  const diagnosticsFile = path.join(root, 'diagnostics.jsonl');
  // Retain only fixture phases and synthetic errors, never configuration or tokens.
  source =
    `import { appendFileSync as appendFixtureDiagnostic } from 'node:fs';
const recordFixtureDiagnostic = (entry) => appendFixtureDiagnostic(${JSON.stringify(diagnosticsFile)}, JSON.stringify(entry) + '\\n');
recordFixtureDiagnostic({ phase: 'start' });
process.on('uncaughtExceptionMonitor', (error) => recordFixtureDiagnostic({ phase: 'uncaught', message: error.message }));
` +
    source.replace(
      'const { id, method, params } = message;',
      "const { id, method, params } = message; recordFixtureDiagnostic({ phase: 'rpc', method });",
    );
  const require = createRequire(import.meta.url);
  for (const specifier of [
    '@modelcontextprotocol/sdk/client/index.js',
    '@modelcontextprotocol/sdk/client/stdio.js',
  ]) {
    source = source.replace(
      `from '${specifier}'`,
      `from ${JSON.stringify(pathToFileURL(require.resolve(specifier)).href)}`,
    );
  }
  const executable = `#!${process.execPath}\n${source}`;
  await writeFile(path.join(root, 'package', 'bin', 'opencode'), executable, {
    mode: 0o700,
  });
  await c({ cwd: root, file: path.join(root, 'fixture.tgz'), gzip: true }, [
    'package',
  ]);
  const archive = await readFile(path.join(root, 'fixture.tgz'));
  const state = { requests: 0, mode: 'normal' };
  const server = createServer((_request, response) => {
    state.requests++;
    response.writeHead(200, { 'content-type': 'application/gzip' });
    if (state.mode === 'slow') {
      response.write(archive.subarray(0, 16));
      return;
    }
    response.end(
      state.mode === 'corrupt' ? Buffer.from('corrupt archive') : archive,
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    async readDiagnostics() {
      const contents = await readFile(diagnosticsFile, 'utf8').catch(
        (error) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        },
      );
      return contents
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    async setAccounts(value) {
      await writeFile(accountsFile, JSON.stringify(value));
    },
    seedConnected(userDataDir) {
      const version = JSON.parse(
        readFileSync(
          new URL('../../../../../package.json', import.meta.url),
          'utf8',
        ),
      )['opencode-cli'].version;
      const directory = path.join(userDataDir, 'opencode-runtime', version);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'opencode'), executable, {
        mode: 0o700,
      });
      const preferencesFile = path.join(userDataDir, 'preferences.json');
      const preferences = JSON.parse(readFileSync(preferencesFile, 'utf8'));
      writeFileSync(
        preferencesFile,
        JSON.stringify({
          ...preferences,
          preferences: {
            ...preferences.preferences,
            opencodeEnabled: true,
          },
        }),
      );
    },
    env: {
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
