import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { c } from 'tar';

const executableName = process.platform === 'win32' ? 'copilot.exe' : 'copilot';

/**
 * Windows cannot run a shebang script, and the installer extracts exactly one
 * regular file, so the fixture must be a self-contained executable there.
 * Compile a tiny launcher with the C# compiler every Windows install ships in
 * the .NET Framework: it starts this Node on the fake agent with the host's
 * arguments, inherited stdio and environment, and exits with Node's code.
 */
function buildWindowsLauncher(root, agentPath) {
  const sourcePath = path.join(root, 'launcher.cs');
  const outputPath = path.join(root, executableName);
  writeFileSync(
    sourcePath,
    readFileSync(
      new URL('./copilot-windows-launcher.cs', import.meta.url),
      'utf8',
    )
      .replace('__NODE__', () => process.execPath)
      .replace('__SCRIPT__', () => agentPath),
  );
  execFileSync(
    path.join(
      process.env.SystemRoot ?? 'C:/Windows',
      'Microsoft.NET',
      'Framework64',
      'v4.0.30319',
      'csc.exe',
    ),
    ['-nologo', '-target:exe', '-optimize+', `-out:${outputPath}`, sourcePath],
    { stdio: 'pipe', windowsHide: true },
  );
  return readFileSync(outputPath);
}

export async function copilotRuntimeFixture({ models = [] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'copilot-runtime-fixture-'));
  await mkdir(path.join(root, 'package'));
  const agentPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'copilot-sdk-agent.mjs',
  );
  const quotaFile = path.join(root, 'quota.json');
  const heldTurnFile = path.join(root, 'held-turn.json');
  const source = (await readFile(agentPath, 'utf8'))
    .replace(
      "const quotaFixtureFile = '';",
      `const quotaFixtureFile = ${JSON.stringify(quotaFile)};`,
    )
    .replace(
      "const heldTurnFixtureFile = '';",
      `const heldTurnFixtureFile = ${JSON.stringify(heldTurnFile)};`,
    );
  const modelSource = source.replace(
    'const presentationModels = [];',
    `const presentationModels = ${JSON.stringify(models)};`,
  );
  const fixtureAgentPath = path.join(root, 'copilot-sdk-agent.mjs');
  await writeFile(fixtureAgentPath, modelSource);
  const executable =
    process.platform === 'win32'
      ? buildWindowsLauncher(root, fixtureAgentPath)
      : `#!${process.execPath}\n${modelSource}`;
  await writeFile(path.join(root, 'package', executableName), executable, {
    mode: 0o700,
  });
  await c({ cwd: root, file: path.join(root, 'fixture.tgz'), gzip: true }, [
    'package',
  ]);
  const archive = await readFile(path.join(root, 'fixture.tgz'));
  const mockBaseUrl = (
    process.env.CANOPY_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:4011'
  ).replace(/\/+$/, '');
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
    async readHeldTurn() {
      try {
        return JSON.parse(await readFile(heldTurnFile, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    async setQuotaSnapshots(quota) {
      await writeFile(quotaFile, JSON.stringify(quota));
    },
    seedConnected(userDataDir, login = 'copilot-fixture') {
      const version = JSON.parse(
        readFileSync(
          new URL('../../../../../package.json', import.meta.url),
          'utf8',
        ),
      )['copilot-cli'].version;
      const directory = path.join(userDataDir, 'copilot-runtime', version);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, executableName), executable, {
        mode: 0o700,
      });
      const account = { host: 'https://github.com', login };
      const preferencesFile = path.join(userDataDir, 'preferences.json');
      const preferences = JSON.parse(readFileSync(preferencesFile, 'utf8'));
      writeFileSync(
        preferencesFile,
        JSON.stringify({
          ...preferences,
          preferences: {
            ...preferences.preferences,
            copilotEnabled: true,
            copilotAccount: account,
          },
        }),
      );
    },
    mockBaseUrl,
    /** Seeds the app-owned grant through the E2E-only startup seam. */
    credentialEnv(login = 'copilot-fixture', overrides = {}) {
      const token = `ghu_e2e_${login}`;
      return {
        CANOPY_E2E_COPILOT_CREDENTIAL: JSON.stringify({
          version: 1,
          clientId: 'Iv23livJwaJtINWS3jkr',
          host: 'https://github.com',
          login,
          id: '4242',
          accessToken: token,
          accessTokenExpiresAt: new Date(
            Date.now() + 8 * 60 * 60 * 1000,
          ).toISOString(),
          refreshToken: `ghr_e2e_${token}`,
          refreshTokenExpiresAt: new Date(
            Date.now() + 180 * 24 * 60 * 60 * 1000,
          ).toISOString(),
          ...overrides,
        }),
      };
    },
    /** The mock GitHub `/user` answer for the token the device flow issues. */
    async registerAccount(login = 'copilot-fixture') {
      const response = await fetch(`${mockBaseUrl}/__mock/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          key: `ghu_e2e_${login}`,
          scenario: { github: { user: { login, id: 4242, type: 'User' } } },
        }),
      });
      if (!response.ok)
        throw new Error(
          `mock scenario registration failed: ${response.status}`,
        );
    },
    /** Approves the code the Settings section is showing, as GitHub would. */
    async approveDeviceCode(window, login = 'copilot-fixture') {
      await this.registerAccount(login);
      const code = (
        await window.getByTestId('copilot-device-code').textContent()
      )?.trim();
      const response = await fetch(
        `${mockBaseUrl}/__mock/github/device/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ user_code: code, key: `ghu_e2e_${login}` }),
        },
      );
      if (!response.ok)
        throw new Error(`device approval failed: ${response.status}`);
    },
    async denyDeviceCode(window) {
      const code = (
        await window.getByTestId('copilot-device-code').textContent()
      )?.trim();
      await fetch(`${mockBaseUrl}/__mock/github/device/deny`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_code: code }),
      });
    },
    env: {
      CANOPY_GITHUB_OAUTH_BASE_URL: mockBaseUrl,
      CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: `${mockBaseUrl}/__mock/github/external-open`,
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-desktop-copilot-harness': true,
      }),
      CANOPY_E2E_COPILOT_RUNTIME: JSON.stringify({
        url: `http://127.0.0.1:${server.address().port}/copilot.tgz`,
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
