// Unit tests for the provider-probe shared harness. No provider binary runs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  CANARY_CATALOG,
  canariesFor,
  createCanarySet,
  readRecorderInvocations,
  writeRecorderScript,
} from '../canaries.mjs';
import {
  PLACEHOLDER_API_KEY,
  buildProbeChildEnv,
  checkProbeEnv,
  isCredentialName,
  isLoopbackUrl,
} from '../child-env.mjs';
import { REQUIREMENTS, STATUS, createLedger } from '../ledger.mjs';
import {
  descendantsOf,
  parseLsofConnections,
  runProbeChild,
  sweepLeaks,
} from '../process-guard.mjs';
import {
  assertOutsideRepository,
  createSyntheticRoot,
  layoutManifest,
  removeSyntheticRoot,
} from '../synthetic-root.mjs';
import { REPO_ROOT } from '../constants.mjs';
import {
  deriveBrowserToolSchemas,
  validateToolArguments,
} from '../tool-schemas.mjs';
import { buildSyntheticObservation, pageSentinel } from '../synthetic-page.mjs';
import { evaluateCanary, startCapture } from '../capture.mjs';

// Mirrors CANARY_PATTERN in outbound-capture.mjs.
const CANARY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,255}$/;

test('synthetic root is outside every repository and removable', async () => {
  const root = await createSyntheticRoot('unit');
  try {
    assert.ok(existsSync(root.codexHome) && existsSync(root.claudeConfigDir));
    assert.throws(() => assertOutsideRepository(root.project), /repository/);
    assert.throws(() => assertOutsideRepository(REPO_ROOT), /repository/);
    const epoch = await root.newEpochDir('epoch-1');
    assert.equal(path.dirname(epoch), root.epochs);
    await assert.rejects(root.newEpochDir('epoch-1'), /unique/);
  } finally {
    await root.cleanup();
  }
  assert.equal(existsSync(root.root), false);
  await assert.rejects(
    removeSyntheticRoot(REPO_ROOT),
    /Not a synthetic probe root/,
  );
});

test('canary tokens are unique and searchable', () => {
  const set = createCanarySet();
  const tokens = Object.values(set);
  assert.equal(new Set(tokens).size, tokens.length);
  for (const token of tokens) assert.match(token, CANARY_PATTERN);
  assert.equal(Object.keys(set).length, CANARY_CATALOG.length);
  assert.ok(
    canariesFor('claude').every((entry) => entry.expected === 'absent'),
  );
  assert.deepEqual(
    canariesFor('codex')
      .filter((entry) => entry.expected === 'accepted')
      .map((entry) => entry.id),
    ['codexGlobalAgents', 'codexGlobalAgentsReplacement'],
  );
});

test('recorder scripts log invocations with an empty PATH', async () => {
  const root = await createSyntheticRoot('unit');
  try {
    const script = await writeRecorderScript(
      root.records,
      'hook',
      'BAP0_HOOK_0123456789',
    );
    await new Promise((resolve, reject) => {
      const child = spawn(script, ['a', 'b'], { env: { PATH: '' } });
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`exit ${code}`)),
      );
    });
    const invocations = await readRecorderInvocations(root.records);
    assert.equal(invocations.hook.length, 1);
    assert.match(invocations.hook[0], /^hook \d+ argc=2$/);
  } finally {
    await root.cleanup();
  }
});

test('child env is synthetic and credential-free; violations report names only', async () => {
  const root = await createSyntheticRoot('unit');
  try {
    const env = buildProbeChildEnv(root, {
      hostEnvCanary: 'BAP0_HOSTENV_0123456789',
    });
    assert.deepEqual(checkProbeEnv(env, { root: root.root, hostEnv: {} }), {
      ok: true,
      violations: [],
    });
    const leaked = {
      ...env,
      OPENAI_API_KEY: 'sk-real',
      HOME: '/Users/someone',
      HTTPS_PROXY: 'http://x',
    };
    const result = checkProbeEnv(leaked, { root: root.root, hostEnv: {} });
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.violations
        .map((violation) => `${violation.name}:${violation.reason}`)
        .sort(),
      [
        'HOME:outside-synthetic-root',
        'HTTPS_PROXY:proxy-variable',
        'OPENAI_API_KEY:credential-name',
      ],
    );
    assert.ok(!JSON.stringify(result).includes('sk-real'));
    const hostValue = checkProbeEnv(
      { ...env, SOMETHING: 'host-secret-value' },
      {
        root: root.root,
        hostEnv: { GITHUB_TOKEN: 'host-secret-value' },
      },
    );
    assert.deepEqual(hostValue.violations, [
      { name: 'SOMETHING', reason: 'host-credential-value' },
    ]);
    const allowed = checkProbeEnv(
      {
        ...env,
        ANTHROPIC_API_KEY: PLACEHOLDER_API_KEY,
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      },
      {
        root: root.root,
        hostEnv: {},
        allow: {
          ANTHROPIC_API_KEY: (value) => value === PLACEHOLDER_API_KEY,
          ANTHROPIC_BASE_URL: isLoopbackUrl,
        },
      },
    );
    assert.equal(allowed.ok, true);
  } finally {
    await root.cleanup();
  }
  assert.ok(isCredentialName('CLAUDE_CODE_OAUTH_TOKEN'));
  assert.ok(!isCredentialName('CODEX_HOME'));
  assert.ok(!isLoopbackUrl('https://api.anthropic.com'));
});

test('derived tool schemas cover the closed set exactly', () => {
  const tools = deriveBrowserToolSchemas();
  assert.equal(tools.length, 22);
  const observe = tools.find((tool) => tool.name === 'observe');
  assert.equal(observe.inputSchema.type, 'object');
  assert.equal(observe.inputSchema.additionalProperties, false);
  assert.ok(tools.every((tool) => /placeholder/i.test(tool.description)));
  assert.equal(
    validateToolArguments('click', {
      target: { observationId: 'o1', ref: 'r1' },
    }).ok,
    true,
  );
  assert.equal(
    validateToolArguments('click', {
      target: { observationId: 'o1', ref: 'r1' },
      extra: 1,
    }).ok,
    false,
  );
  assert.equal(
    validateToolArguments('navigate', { url: 'file:///etc/passwd' }).ok,
    false,
  );
});

test('synthetic observation is at the structural bound and embeds its sentinel', () => {
  const sentinel = pageSentinel(2, 'abcdef0123');
  assert.match(sentinel, CANARY_PATTERN);
  const observation = buildSyntheticObservation({
    sentinel,
    epoch: 2,
    step: 3,
  });
  assert.equal(observation.controls.length, 100);
  assert.equal(observation.visibleText.text.length, 6000);
  assert.ok(JSON.stringify(observation).includes(sentinel));
});

test('ledger fills every applicable requirement and rejects unknown ids', () => {
  const ledger = createLedger('claude');
  ledger.record('canonical.home', 'launch', STATUS.pass, { ok: true });
  assert.throws(
    () => ledger.record('nope', 'launch', STATUS.pass),
    /Unknown requirement/,
  );
  assert.throws(
    () => ledger.record('launch.instruction-sources', 'launch', STATUS.pass),
    /does not apply/,
  );
  const final = ledger.finalize();
  const expected = REQUIREMENTS.filter((item) => !item.followUp).reduce(
    (sum, requirement) => sum + requirement.phases.length,
    0,
  );
  assert.equal(final.entries.length, expected);
  assert.equal(
    final.entries.find((entry) => entry.id === 'launch.instruction-sources')
      .status,
    STATUS.notApplicable,
  );
  assert.equal(
    final.entries.find((entry) => entry.id === 'phase.compaction').status,
    STATUS.unobserved,
  );
  assert.equal(final.failed, false);
});

test('process helpers parse ps/lsof and sweep leaks', async () => {
  const tree = descendantsOf(
    [
      { pid: 10, ppid: 1, pgid: 10, command: 'root' },
      { pid: 11, ppid: 10, pgid: 10, command: 'child' },
      { pid: 12, ppid: 11, pgid: 12, command: 'grandchild' },
      { pid: 13, ppid: 1, pgid: 13, command: 'other' },
    ],
    10,
  );
  assert.deepEqual(
    tree.map((proc) => proc.pid),
    [11, 12],
  );
  const lsof = [
    'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
    'codex 42 me 10u IPv4 0x1 0t0 TCP 127.0.0.1:5000->127.0.0.1:6000 (ESTABLISHED)',
    'codex 42 me 11u IPv4 0x2 0t0 TCP 10.0.0.2:5001->104.18.1.1:443 (ESTABLISHED)',
    'node 43 me 12u IPv6 0x3 0t0 TCP [::1]:7000 (LISTEN)',
  ].join('\n');
  const connections = parseLsofConnections(lsof);
  assert.deepEqual(
    connections.map((connection) => connection.loopback),
    [true, false],
  );
  const sleeper = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  await new Promise((resolve) => sleeper.once('spawn', resolve));
  const leaks = await sweepLeaks(
    [{ pid: sleeper.pid, command: '/bin/sleep 30' }],
    100,
  );
  assert.equal(leaks.length, 1);
  await new Promise((resolve) =>
    sleeper.exitCode !== null || sleeper.signalCode !== null
      ? resolve()
      : sleeper.once('exit', resolve),
  );
});

test('capture wrapper records every channel and grades canaries', async () => {
  const { capture, close, baseUrl } = await startCapture();
  try {
    await fetch(`${baseUrl}/v1/models`);
    await fetch(`${baseUrl}/unrouted/BAP0_PATHLEAK_0123456789`, {
      method: 'POST',
      body: 'x',
    });
    const snapshot = capture.snapshot();
    assert.equal(snapshot.counts.received, 2);
    assert.equal(
      evaluateCanary(snapshot, 'BAP0_PATHLEAK_0123456789', 'absent').status,
      STATUS.fail,
    );
    assert.equal(
      evaluateCanary(snapshot, 'BAP0_ABSENT_0123456789', 'absent').status,
      STATUS.pass,
    );
    assert.equal(
      evaluateCanary(snapshot, 'BAP0_ABSENT_0123456789', 'accepted').status,
      STATUS.fail,
    );
  } finally {
    await close();
  }
});

test('orchestrator self-check is static and passes on the current pins', async () => {
  const { selfCheck } = await import('../../orchestrator.mjs');
  const check = await selfCheck();
  assert.equal(check.pinsOk, true);
  assert.equal(check.env.ok, true);
  assert.equal(check.rootRemoved, true);
  assert.equal(check.tools.toolCount, 22);
  assert.equal(check.observation.controls, 100);
});

test('child layout remains valid when TMPDIR points inside its owned root', async () => {
  const root = await createSyntheticRoot('child-unit');
  try {
    const moduleUrl = new URL('../synthetic-root.mjs', import.meta.url).href;
    const code = `import { attachLayoutHelpers } from ${JSON.stringify(moduleUrl)}; await attachLayoutHelpers(JSON.parse(process.argv[1])).newEpochDir('child-epoch');`;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          code,
          JSON.stringify(layoutManifest(root)),
        ],
        {
          env: buildProbeChildEnv(root, {
            hostEnvCanary: 'BAP0_CHILDENV_0123456789',
          }),
        },
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(existsSync(path.join(root.epochs, 'child-epoch')));
  } finally {
    await root.cleanup();
  }
});

test('provider subprocess starts outside the checkout in its synthetic home', async () => {
  const root = await createSyntheticRoot('cwd-unit');
  try {
    const script = path.join(root.records, 'cwd.mjs');
    const stdoutPath = path.join(root.records, 'stdout.log');
    await writeFile(
      script,
      "import '@canopy/brand/current'; process.stdout.write(process.cwd());",
    );
    const result = await runProbeChild({
      script,
      env: buildProbeChildEnv(root, {
        hostEnvCanary: 'BAP0_CHILDENV_0123456789',
      }),
      deadlineMs: 30000,
      stdoutPath,
      stderrPath: path.join(root.records, 'stderr.log'),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(await readFile(stdoutPath, 'utf8'), root.home);
    assert.equal(result.leaks.length, 0);
  } finally {
    await root.cleanup();
  }
});

test('synthetic Git configuration refuses HTTP discovery even without inherited Git variables', async () => {
  const root = await createSyntheticRoot('git-unit');
  let hits = 0;
  const server = createServer((_request, response) => {
    hits++;
    response.writeHead(404);
    response.end();
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        'git',
        ['ls-remote', `http://127.0.0.1:${server.address().port}/fixture.git`],
        {
          cwd: root.home,
          env: {
            HOME: root.home,
            PATH: '/usr/bin:/bin',
            GIT_TERMINAL_PROMPT: '0',
          },
        },
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code, stderr }));
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /transport .*http.*not allowed/);
    assert.equal(hits, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await root.cleanup();
  }
});

test(
  'native containment permits loopback and rejects non-loopback with EPERM',
  { skip: process.platform !== 'darwin', timeout: 30000 },
  async () => {
    const root = await createSyntheticRoot('sandbox-unit');
    const server = createServer((_request, response) => response.end('owned'));
    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const script = path.join(root.records, 'network.mjs');
      const source = `import net from 'node:net'; import { listProcesses } from ${JSON.stringify(new URL('../process-guard.mjs', import.meta.url).href)};
      const connect = (host, port) => new Promise(resolve => {
        const socket = net.connect({host, port});
        socket.setTimeout(2000);
        socket.once('connect', () => { socket.destroy(); resolve('connected'); });
        socket.once('error', error => resolve(error.code));
        socket.once('timeout', () => { socket.destroy(); resolve('timeout'); });
      });
      process.stdout.write(JSON.stringify({loopback: await connect('127.0.0.1', ${server.address().port}), denied: await connect('203.0.113.1', 80), processObserved: (await listProcesses()).some(entry => entry.pid === process.pid)}));`;
      await writeFile(script, source);
      const stdoutPath = path.join(root.records, 'stdout.log');
      const result = await runProbeChild({
        script,
        env: buildProbeChildEnv(root, {
          hostEnvCanary: 'BAP0_CHILDENV_0123456789',
        }),
        networkIsolation: true,
        deadlineMs: 25000,
        stdoutPath,
        stderrPath: path.join(root.records, 'stderr.log'),
      });
      assert.equal(result.exitCode, 0, result.stderrTail);
      assert.deepEqual(JSON.parse(await readFile(stdoutPath, 'utf8')), {
        loopback: 'connected',
        denied: 'EPERM',
        processObserved: true,
      });
      assert.equal(result.leaks.length, 0);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await root.cleanup();
    }
  },
);

test('follow-up auth metadata never retains credential values', async () => {
  const {
    classifySyntheticAuth,
    SYNTHETIC_OAUTH_TOKEN,
    CONTEXT_CHECKPOINT_TOKENS,
  } = await import('../followup-policy.mjs');
  assert.equal(CONTEXT_CHECKPOINT_TOKENS, 125000);
  const value = classifySyntheticAuth({
    authorization: `Bearer ${SYNTHETIC_OAUTH_TOKEN}`,
    'x-api-key': 'secret-real-looking-sentinel',
  });
  assert.deepEqual(value, {
    bearer: true,
    apiKey: true,
    syntheticOAuth: true,
    syntheticApiKey: false,
  });
  assert.ok(!JSON.stringify(value).includes(SYNTHETIC_OAUTH_TOKEN));
  assert.ok(!JSON.stringify(value).includes('secret-real-looking-sentinel'));
  assert.deepEqual(classifySyntheticAuth({}), {
    bearer: false,
    apiKey: false,
    syntheticOAuth: false,
    syntheticApiKey: false,
  });
});

test(
  'follow-up sandbox denies a synthetic host keychain file',
  { skip: process.platform !== 'darwin', timeout: 30000 },
  async () => {
    const root = await createSyntheticRoot('keychain-containment');
    try {
      const dir = path.join(root.home, 'Library', 'Keychains');
      await mkdir(dir, { recursive: true });
      const fixture = path.join(dir, 'synthetic.keychain-db');
      await writeFile(fixture, 'fixture-canary');
      assert.equal(await readFile(fixture, 'utf8'), 'fixture-canary');
      const script = path.join(root.records, 'keychain.mjs');
      await writeFile(
        script,
        `import {readFile} from 'node:fs/promises'; try { await readFile(${JSON.stringify(fixture)}); process.stdout.write('read'); } catch(error) { process.stdout.write(error.code); }`,
      );
      const out = path.join(root.records, 'stdout.log');
      const result = await runProbeChild({
        script,
        env: buildProbeChildEnv(root, {
          hostEnvCanary: 'BAP0_KEYCHAIN_0123456789',
        }),
        networkIsolation: true,
        credentialIsolation: true,
        credentialHome: root.home,
        deadlineMs: 25000,
        stdoutPath: out,
        stderrPath: path.join(root.records, 'stderr.log'),
      });
      assert.equal(result.exitCode, 0, result.stderrTail);
      assert.equal(await readFile(out, 'utf8'), 'EPERM');
      assert.equal(result.leaks.length, 0);
    } finally {
      await root.cleanup();
    }
  },
);
