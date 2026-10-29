import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { startOpenCodeRuntime } from '../runtime';
import { runOpenCodeTurn, type OpenCodeTurnHost } from '../turn-driver';

const fixture = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));

for (const mode of ['absolute', 'relative', 'unset', 'empty'] as const)
  void test(`shell commands retain ${mode} caller XDG roots without changing runtime isolation`, async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-shell-env-'));
    const home = path.join(cwd, 'home');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_DATA_HOME: path.join(cwd, 'data'),
      OPENCODE_AUTH_CONTENT: '{}',
    };
    const keys = ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];
    for (const key of keys) {
      delete env[key];
      if (mode === 'absolute') env[key] = path.join(cwd, key);
      if (mode === 'relative') env[key] = key;
      if (mode === 'empty') env[key] = '';
    }
    const configRoot = path.resolve(
      cwd,
      env.XDG_CONFIG_HOME || path.join(home, '.config'),
    );
    await mkdir(path.join(configRoot, 'gh'), { recursive: true });
    await writeFile(
      path.join(configRoot, 'gh', 'hosts.yml'),
      'fixture CLI config',
    );
    let approvals = 0;
    try {
      const result = await runOpenCodeTurn(
        {
          executable: process.execPath,
          prefix: [fixture],
          env,
          cwd,
          profileDir: path.join(cwd, 'profile'),
          rawModelId: 'fixture/model',
          prompt: 'SHELL_ENV',
          signal: AbortSignal.timeout(10_000),
        },
        {
          authorize: () => {
            approvals++;
            return Promise.resolve({ decision: 'allow' });
          },
          emit: () => undefined,
        },
      );
      assert.equal(result.isError, false);
      assert.deepEqual(JSON.parse(result.responseText), {
        config: 'fixture CLI config',
        roots: keys.map((key) => env[key] ?? null),
        runtimeIsolated: true,
      });
      assert.equal(approvals, 1);
      // Writes by CLI tools survive teardown of the private runtime directory.
      assert.equal(
        await readFile(path.join(configRoot, 'shell-created.txt'), 'utf8'),
        'persisted',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

void test('approved rewrites reach execution and the completed transcript', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-rewrite-'));
  const events: Record<string, unknown>[] = [];
  const approved = {
    path: path.join(cwd, 'rewritten.txt'),
    content: 'rewritten',
  };
  try {
    const result = await runOpenCodeTurn(
      {
        executable: process.execPath,
        prefix: [fixture],
        env: process.env,
        cwd,
        profileDir: path.join(cwd, 'profile'),
        rawModelId: 'fixture/model',
        prompt: 'WRITE',
        signal: AbortSignal.timeout(10_000),
      },
      {
        authorize: () =>
          Promise.resolve({ decision: 'allow', updatedInput: approved }),
        emit: (event) => {
          events.push(event);
        },
      },
    );
    assert.equal(result.isError, false);
    const completions = events.filter((event) =>
      JSON.stringify(event).includes('tool_result'),
    );
    assert.ok(completions.length > 0);
    assert.match(JSON.stringify(completions), /rewritten\.txt/);
    assert.doesNotMatch(JSON.stringify(completions), /sentinel\.txt/);
    assert.equal(await readFile(approved.path, 'utf8'), approved.content);
    await assert.rejects(readFile(path.join(cwd, 'sentinel.txt')));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test('ignores inherited database and managed configuration sources', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-config-sources-'));
  try {
    const result = await runOpenCodeTurn(
      {
        executable: process.execPath,
        prefix: [fixture],
        env: {
          ...process.env,
          OPENCODE_DB: 'untrusted-native.db',
          OPENCODE_TEST_MANAGED_CONFIG_DIR: 'untrusted-managed',
        },
        cwd,
        profileDir: path.join(cwd, 'profile'),
        rawModelId: 'fixture/model',
        prompt: 'CONFIG_SOURCES',
        signal: AbortSignal.timeout(10_000),
      },
      {
        authorize: () => Promise.resolve({ decision: 'deny' }),
        emit: () => undefined,
      },
    );
    assert.equal(result.isError, false);
    assert.equal(result.responseText, 'Configuration isolated.');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const source of ['file', 'relative-file', 'environment'] as const)
  void test(`rejects remote configuration credentials from ${source} before launch`, async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-remote-auth-'));
    const data = path.join(cwd, 'data');
    const auth = JSON.stringify({
      'https://unselected.invalid/': {
        type: 'wellknown',
        key: 'TEST_TOKEN',
        token: 'not-a-real-secret',
      },
    });
    const env = {
      ...process.env,
      XDG_DATA_HOME: source === 'relative-file' ? 'data' : data,
      OPENCODE_AUTH_CONTENT: source === 'environment' ? auth : '',
    };
    await mkdir(path.join(data, 'opencode'), { recursive: true });
    await writeFile(
      path.join(data, 'opencode', 'auth.json'),
      source === 'environment' ? '{}' : auth,
    );
    try {
      const result = await runOpenCodeTurn(
        {
          executable: process.execPath,
          prefix: [fixture],
          env,
          cwd,
          profileDir: path.join(cwd, 'profile'),
          rawModelId: 'fixture/model',
          prompt: 'WRITE',
          signal: AbortSignal.timeout(10_000),
        },
        {
          authorize: () => Promise.resolve({ decision: 'allow' }),
          emit: () => undefined,
        },
      );
      assert.equal(result.isError, true);
      assert.match(result.message, /remote configuration/);
      assert.equal(result.sessionId, undefined);
      await assert.rejects(readFile(path.join(cwd, 'sentinel.txt')));
      assert.equal(
        await readFile(path.join(data, 'opencode', 'auth.json'), 'utf8'),
        source === 'environment' ? '{}' : auth,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

void test('an oversized approved rewrite cannot fall back to executing the original input', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-rewrite-limit-'));
  try {
    const result = await runOpenCodeTurn(
      {
        executable: process.execPath,
        prefix: [fixture],
        env: process.env,
        cwd,
        profileDir: path.join(cwd, 'profile'),
        rawModelId: 'fixture/model',
        prompt: 'WRITE',
        signal: AbortSignal.timeout(10_000),
      },
      {
        authorize: () =>
          Promise.resolve({
            decision: 'allow',
            updatedInput: {
              path: path.join(cwd, 'rewritten.txt'),
              content: 'x'.repeat(66_000),
            },
          }),
        emit: () => undefined,
      },
    );
    assert.equal(result.responseText, 'Write denied.');
    await assert.rejects(readFile(path.join(cwd, 'sentinel.txt')));
    await assert.rejects(readFile(path.join(cwd, 'rewritten.txt')));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// V2 validates and executes resource inputs after the pre-tool hook.
for (const tool of [
  'opencode_list_mcp_resources',
  'list_mcp_resource_templates',
  'opencode_read_mcp_resource',
])
  for (const rewrite of [false, true])
    void test(`${tool} ${rewrite ? 'executes the approved rewrite' : 'allows unchanged input'}`, async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-resource-'));
      try {
        const result = await runOpenCodeTurn(
          {
            executable: process.execPath,
            prefix: [fixture],
            env: process.env,
            cwd,
            profileDir: path.join(cwd, 'profile'),
            rawModelId: 'fixture/model',
            prompt: tool,
            signal: AbortSignal.timeout(10_000),
          },
          {
            authorize: () =>
              Promise.resolve({
                decision: 'allow',
                ...(rewrite
                  ? {
                      updatedInput: {
                        server: 'approved',
                        uri: 'resource://approved',
                      },
                    }
                  : {}),
              }),
            emit: () => undefined,
          },
        );
        assert.equal(result.responseText, 'Resource allowed.');
        assert.equal(
          await readFile(path.join(cwd, 'resource-executed.txt'), 'utf8'),
          rewrite ? 'approved' : 'original',
        );
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

for (const decision of ['allow', 'deny'] as const)
  void test(`tool execution waits for the host ${decision} decision`, async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-test-'));
    const events: Record<string, unknown>[] = [];
    const calls: string[] = [];
    try {
      const result = await runOpenCodeTurn(
        {
          executable: process.execPath,
          prefix: [fixture],
          env: process.env,
          cwd,
          profileDir: path.join(cwd, 'profile'),
          rawModelId: 'fixture/model',
          prompt: 'WRITE',
          signal: new AbortController().signal,
        },
        {
          authorize: async (input) => {
            calls.push(input.toolName);
            await assert.rejects(readFile(path.join(cwd, 'sentinel.txt')));
            return { decision };
          },
          emit: (event) => {
            events.push(event);
          },
        },
      );
      assert.equal(result.isError, false);
      assert.equal(result.sessionId, 'opencode-fixture');
      assert.deepEqual(calls, ['write']);
      if (decision === 'allow')
        assert.equal(
          await readFile(path.join(cwd, 'sentinel.txt'), 'utf8'),
          'approved',
        );
      else await assert.rejects(readFile(path.join(cwd, 'sentinel.txt')));
      assert.match(JSON.stringify(events), /Thinking/);
      assert.match(
        result.responseText,
        decision === 'allow' ? /Write allowed/ : /Write denied/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

void test('resume suppresses history replay and does not replace an unavailable session', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-resume-'));
  const events: Record<string, unknown>[] = [];
  try {
    const request = {
      executable: process.execPath,
      prefix: [fixture],
      env: process.env,
      cwd,
      profileDir: path.join(cwd, 'profile'),
      rawModelId: 'fixture/model',
      prompt: 'Hello',
      signal: new AbortController().signal,
    };
    const host: OpenCodeTurnHost = {
      authorize: () => Promise.resolve({ decision: 'deny' }),
      emit: (event: Record<string, unknown>): void => {
        events.push(event);
      },
    };
    const created = await runOpenCodeTurn(request, host);
    const resumed = await runOpenCodeTurn(
      { ...request, sessionId: created.sessionId },
      host,
    );
    assert.equal(resumed.sessionId, created.sessionId);
    assert.equal(resumed.isError, false);
    assert.doesNotMatch(JSON.stringify(events), /Replayed history/);
    const missing = await runOpenCodeTurn(
      { ...request, sessionId: 'missing' },
      host,
    );
    assert.equal(missing.isError, true);
    assert.equal(missing.responseText, '');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test('Stop cancels and drains the process before returning', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-stop-'));
  const abort = new AbortController();
  try {
    const result = await runOpenCodeTurn(
      {
        executable: process.execPath,
        prefix: [fixture],
        env: process.env,
        cwd,
        profileDir: path.join(cwd, 'profile'),
        rawModelId: 'fixture/model',
        prompt: 'HOLD',
        signal: abort.signal,
      },
      {
        authorize: () => Promise.resolve({ decision: 'deny' }),
        emit: (event) => {
          if (JSON.stringify(event).includes('Waiting.')) abort.abort();
        },
      },
    );
    assert.equal(result.cancelled, true);
    assert.equal(result.isError, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test('concurrent hook deliveries cannot execute one tool call twice', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-duplicate-'));
  let calls = 0;
  try {
    const result = await runOpenCodeTurn(
      {
        executable: process.execPath,
        prefix: [fixture],
        env: process.env,
        cwd,
        profileDir: path.join(cwd, 'profile'),
        rawModelId: 'fixture/model',
        prompt: 'DUPLICATE',
        signal: AbortSignal.timeout(10_000),
      },
      {
        authorize: async () => {
          calls++;
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { decision: 'allow' };
        },
        emit: () => undefined,
      },
    );
    assert.equal(calls, 1);
    assert.equal(result.isError, false);
    assert.equal(result.responseText, 'Approved attempts: 1');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test('an unapproved tool completion terminates the turn', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-rogue-'));
  try {
    const result = await runOpenCodeTurn(
      {
        executable: process.execPath,
        prefix: [fixture],
        env: process.env,
        cwd,
        profileDir: path.join(cwd, 'profile'),
        rawModelId: 'fixture/model',
        prompt: 'UNAPPROVED',
        signal: AbortSignal.timeout(10_000),
      },
      {
        authorize: () => Promise.resolve({ decision: 'deny' }),
        emit: () => undefined,
      },
    );
    assert.equal(result.isError, true);
    assert.equal(result.cancelled, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const mode of ['absent', 'mismatch', 'snap-model', 'supported'] as const)
  void test(`thinking ${mode} is acknowledged before a write-capable prompt`, async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-thinking-'));
    try {
      const result = await runOpenCodeTurn(
        {
          executable: process.execPath,
          prefix: [fixture],
          env: { ...process.env, OPENCODE_FIXTURE_EFFORT: mode },
          cwd,
          profileDir: path.join(cwd, 'profile'),
          rawModelId: 'fixture/model',
          thinkingLevel: 'high',
          prompt: 'WRITE',
          signal: AbortSignal.timeout(10_000),
        },
        {
          authorize: () => Promise.resolve({ decision: 'allow' }),
          emit: () => undefined,
        },
      );
      assert.equal(result.isError, mode !== 'supported');
      if (mode === 'supported')
        assert.equal(
          await readFile(path.join(cwd, 'sentinel.txt'), 'utf8'),
          'approved',
        );
      else await assert.rejects(readFile(path.join(cwd, 'sentinel.txt')));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

for (const saved of ['missing', 'transient', 'unsupported'] as const)
  void test(`interactive recovery distinguishes ${saved} context before prompting`, async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-recovery-'));
    const events: Record<string, unknown>[] = [];
    try {
      await runOpenCodeTurn(
        {
          executable: process.execPath,
          prefix: [fixture],
          env: { ...process.env, OPENCODE_FIXTURE_SESSION_ID: saved },
          cwd,
          profileDir: path.join(cwd, 'profile'),
          rawModelId: 'fixture/model',
          prompt: 'Hello',
          signal: AbortSignal.timeout(10_000),
        },
        {
          authorize: () => Promise.resolve({ decision: 'deny' }),
          emit: () => undefined,
        },
      );
      const strict = await runOpenCodeTurn(
        {
          executable: process.execPath,
          prefix: [fixture],
          env: {
            ...process.env,
            OPENCODE_FIXTURE_LOAD: saved,
            OPENCODE_FIXTURE_LAZY_PLUGIN: 'true',
          },
          cwd,
          profileDir: path.join(cwd, 'profile'),
          rawModelId: 'fixture/model',
          sessionId: saved,
          prompt: 'WRITE',
          signal: AbortSignal.timeout(10_000),
        },
        {
          authorize: () => Promise.resolve({ decision: 'allow' }),
          emit: () => undefined,
        },
      );
      assert.equal(strict.isError, true);
      assert.equal(strict.sessionId, saved);
      await assert.rejects(readFile(path.join(cwd, 'sentinel.txt')));
      const result = await runOpenCodeTurn(
        {
          executable: process.execPath,
          prefix: [fixture],
          env: {
            ...process.env,
            OPENCODE_FIXTURE_LOAD: saved,
            OPENCODE_FIXTURE_LAZY_PLUGIN: 'true',
          },
          cwd,
          profileDir: path.join(cwd, 'profile'),
          rawModelId: 'fixture/model',
          sessionId: saved,
          resumePolicy: 'recover',
          prompt: 'WRITE',
          signal: AbortSignal.timeout(10_000),
        },
        {
          authorize: () => Promise.resolve({ decision: 'allow' }),
          emit: (event) => {
            events.push(event);
          },
        },
      );
      assert.equal(result.isError, saved === 'transient');
      if (saved !== 'transient') {
        assert.equal(result.sessionId, 'opencode-fixture');
        assert.match(JSON.stringify(events), /Started a new OpenCode session/);
        assert.equal(
          await readFile(path.join(cwd, 'sentinel.txt'), 'utf8'),
          'approved',
        );
      } else {
        assert.equal(result.sessionId, saved);
        assert.match(result.message, /try again/i);
        await assert.rejects(readFile(path.join(cwd, 'sentinel.txt')));
        assert.doesNotMatch(JSON.stringify(events), /Started a new/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

void test('resume rejects a changed capability generation and persists a secret-free snapshot', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-snapshot-'));
  try {
    const request = {
      executable: process.execPath,
      prefix: [fixture],
      env: process.env,
      cwd,
      profileDir: path.join(cwd, 'profile'),
      rawModelId: 'fixture/model',
      prompt: 'Hello',
      signal: AbortSignal.timeout(10_000),
      capabilityContext: { skills: ['one'], setting: 'credential-secret' },
    };
    const host: OpenCodeTurnHost = {
      authorize: () => Promise.resolve({ decision: 'deny' }),
      emit: () => undefined,
    };
    const first = await runOpenCodeTurn(request, host);
    assert.equal(first.isError, false);
    const changed = await runOpenCodeTurn(
      {
        ...request,
        sessionId: first.sessionId,
        capabilityContext: { skills: ['two'] },
      },
      host,
    );
    assert.equal(changed.isError, true);
    assert.match(changed.message, /capabilities changed/i);
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(
      path.join(request.profileDir, 'capability-snapshots'),
    );
    assert.ok(files.length > 0);
    for (const file of files)
      assert.doesNotMatch(
        await readFile(
          path.join(request.profileDir, 'capability-snapshots', file),
          'utf8',
        ),
        /credential-secret/,
      );
    const resumed = await runOpenCodeTurn(
      { ...request, sessionId: first.sessionId },
      host,
    );
    assert.equal(resumed.isError, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const decision of ['allow', 'deny'] as const)
  void test(`interactive approval waits for a late ${decision} decision`, async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), 'opencode-approval-wait-'),
    );
    let decided = false;
    try {
      const result = await runOpenCodeTurn(
        {
          executable: process.execPath,
          prefix: [fixture],
          env: { ...process.env, OPENCODE_FIXTURE_FAST_TIMEOUTS: '1' },
          cwd,
          profileDir: path.join(cwd, 'profile'),
          rawModelId: 'fixture/model',
          prompt: 'WRITE',
          signal: AbortSignal.timeout(10_000),
        },
        {
          authorize: async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            await assert.rejects(readFile(path.join(cwd, 'sentinel.txt')));
            decided = true;
            return { decision };
          },
          emit: () => undefined,
        },
      );
      assert.equal(decided, true, 'turn ended before the host decided');
      assert.equal(
        result.responseText,
        decision === 'allow' ? 'Write allowed.' : 'Write denied.',
      );
      if (decision === 'allow')
        assert.equal(
          await readFile(path.join(cwd, 'sentinel.txt'), 'utf8'),
          'approved',
        );
      else await assert.rejects(readFile(path.join(cwd, 'sentinel.txt')));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

void test('Stop ends an unresolved approval without executing the tool', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-approval-stop-'));
  const abort = new AbortController();
  try {
    const result = await runOpenCodeTurn(
      {
        executable: process.execPath,
        prefix: [fixture],
        env: process.env,
        cwd,
        profileDir: path.join(cwd, 'profile'),
        rawModelId: 'fixture/model',
        prompt: 'WRITE',
        signal: abort.signal,
      },
      {
        authorize: () => {
          abort.abort();
          return new Promise(() => undefined);
        },
        emit: () => undefined,
      },
    );
    assert.equal(result.cancelled, true);
    await assert.rejects(readFile(path.join(cwd, 'sentinel.txt')));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const reference of ['environment', 'file'] as const)
  void test(`strict resume binds the effective ${reference} provider settings without persisting secrets`, async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), 'opencode-provider-resume-'),
    );
    const endpoint = path.join(cwd, 'endpoint.txt');
    await writeFile(endpoint, 'https://first.invalid');
    try {
      const request = {
        executable: process.execPath,
        prefix: [fixture],
        cwd,
        profileDir: path.join(cwd, 'profile'),
        rawModelId: 'fixture/model',
        prompt: 'CONFIG_PROVIDER',
        signal: AbortSignal.timeout(15_000),
        env: { ...process.env, INFERENCE_URL: 'https://first.invalid' },
        providerConfig: {
          provider: {
            fixture: {
              options: {
                baseURL:
                  reference === 'environment'
                    ? '{env:INFERENCE_URL}'
                    : `{file:${endpoint}}`,
              },
            },
          },
        },
      };
      const host: OpenCodeTurnHost = {
        authorize: () => Promise.resolve({ decision: 'deny' }),
        emit: () => undefined,
      };
      const first = await runOpenCodeTurn(request, host);
      assert.equal(first.isError, false, first.message);
      assert.deepEqual(JSON.parse(first.responseText), {
        fixture: { options: { baseURL: 'https://first.invalid' } },
      });
      const unchanged = await runOpenCodeTurn(
        { ...request, sessionId: first.sessionId },
        host,
      );
      assert.equal(unchanged.isError, false, unchanged.message);
      await writeFile(endpoint, 'https://second.invalid');
      const changed = await runOpenCodeTurn(
        {
          ...request,
          sessionId: first.sessionId,
          env: { ...request.env, INFERENCE_URL: 'https://second.invalid' },
        },
        host,
      );
      assert.equal(
        changed.isError,
        true,
        'changed endpoint must reject strict resume',
      );
      assert.match(changed.message, /capabilities changed/i);
      const { readdir } = await import('node:fs/promises');
      for (const file of await readdir(
        path.join(request.profileDir, 'capability-snapshots'),
      ))
        assert.doesNotMatch(
          await readFile(
            path.join(request.profileDir, 'capability-snapshots', file),
            'utf8',
          ),
          /first\.invalid|second\.invalid|INFERENCE_URL|endpoint\.txt/,
        );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

void test('provider execution uses the same frozen literal values as its capability digest', async () => {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), 'opencode-provider-frozen-'),
  );
  try {
    const file = path.join(cwd, 'credential.txt');
    await writeFile(file, '  synthetic-{env:SECOND}-{file:missing.txt}  ');
    const result = await runOpenCodeTurn(
      {
        executable: process.execPath,
        prefix: [fixture],
        cwd,
        profileDir: path.join(cwd, 'profile'),
        env: { ...process.env, SECOND: 'must-not-expand' },
        signal: AbortSignal.timeout(10000),
        rawModelId: 'fixture/model',
        prompt: 'CONFIG_PROVIDER',
        providerConfig: {
          provider: { fixture: { options: { apiKey: `{file:${file}}` } } },
        },
      },
      {
        authorize: () => Promise.resolve({ decision: 'deny' }),
        emit: () => undefined,
      },
    );
    assert.equal(result.isError, false, result.message);
    assert.deepEqual(JSON.parse(result.responseText), {
      fixture: {
        options: { apiKey: 'synthetic-{env:SECOND}-{file:missing.txt}' },
      },
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const supported of [true, false])
  void test(`delivers attachment blocks only with negotiated support (${supported})`, async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), 'opencode-prompt-content-'),
    );
    const promptContent = [
      { type: 'image' as const, mimeType: 'image/png', data: 'aW1hZ2U=' },
      {
        type: 'resource' as const,
        resource: {
          uri: 'file:///attachment.txt',
          mimeType: 'text/plain',
          text: 'Attachment contents',
        },
      },
    ];
    try {
      const result = await runOpenCodeTurn(
        {
          executable: process.execPath,
          prefix: [fixture],
          env: {
            ...process.env,
            OPENCODE_FIXTURE_PROMPT_CONTENT: supported ? 'enabled' : 'disabled',
          },
          cwd,
          profileDir: path.join(cwd, 'profile'),
          rawModelId: 'fixture/model',
          prompt: 'PROMPT_CONTENT',
          promptContent,
          signal: AbortSignal.timeout(10_000),
        },
        {
          authorize: () => Promise.resolve({ decision: 'deny' }),
          emit: () => undefined,
        },
      );
      if (supported) {
        assert.equal(result.isError, false, result.message);
        assert.deepEqual(JSON.parse(result.responseText), promptContent);
      } else {
        assert.equal(result.isError, true);
        assert.match(result.message, /attachment|content type/i);
        await assert.rejects(readFile(path.join(cwd, 'prompt-called')));
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

void test('aggregates ignored update kinds without retaining content or metadata', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-diagnostics-'));
  try {
    const result = await runOpenCodeTurn(
      {
        executable: process.execPath,
        prefix: [fixture],
        cwd,
        env: process.env,
        profileDir: path.join(cwd, 'profile'),
        rawModelId: 'fixture/model',
        prompt: 'IGNORED_UPDATES',
        signal: AbortSignal.timeout(10_000),
      },
      {
        authorize: () => Promise.resolve({ decision: 'deny' }),
        emit: () => undefined,
      },
    );
    assert.equal(result.isError, false, result.message);
    assert('diagnostics' in result);
    assert.deepEqual(result.diagnostics, {
      ignoredUpdates: { available_commands_update: 80 },
      ignoredContent: { image: 1 },
    });
    assert(!JSON.stringify(result.diagnostics).includes('SECRET'));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test('reports new turn counters and native context without using cumulative native cost', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-usage-'));
  const events: Record<string, unknown>[] = [];
  try {
    const result = await runOpenCodeTurn(
      {
        executable: process.execPath,
        prefix: [fixture],
        env: { ...process.env, OPENCODE_FIXTURE_USAGE: '1' },
        cwd,
        profileDir: path.join(cwd, 'profile'),
        rawModelId: 'fixture/model',
        prompt: 'USAGE',
        signal: AbortSignal.timeout(10_000),
      },
      {
        authorize: () => Promise.resolve({ decision: 'deny' }),
        emit: (event) => {
          events.push(event);
        },
      },
    );
    assert.equal(result.isError, false);
    assert.deepEqual(result.usage, {
      input_tokens: 100,
      output_tokens: 60,
      reasoning_tokens: 10,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 20,
    });
    assert.deepEqual(
      events.filter((event) => event.type === 'canopy_opencode_usage').at(-1)
        ?.usage,
      {
        turn: {
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 10,
          cacheReadTokens: 30,
          cacheWriteTokens: 20,
        },
        context: { usedTokens: 1234, maxTokens: 10000 },
      },
    );
    assert.equal(result.diagnostics, undefined);
    const continued = async (
      prompt: string,
    ): Promise<Awaited<ReturnType<typeof runOpenCodeTurn>>> =>
      runOpenCodeTurn(
        {
          executable: process.execPath,
          prefix: [fixture],
          env: { ...process.env, OPENCODE_FIXTURE_USAGE: '1' },
          cwd,
          profileDir: path.join(cwd, 'profile'),
          rawModelId: 'fixture/model',
          sessionId: result.sessionId,
          prompt,
          signal: AbortSignal.timeout(10_000),
        },
        {
          authorize: () => Promise.resolve({ decision: 'deny' }),
          emit: () => undefined,
        },
      );
    const resumed = await continued('USAGE');
    assert.equal(resumed.isError, false);
    assert.equal(resumed.sessionId, result.sessionId);
    assert.deepEqual(
      resumed.usage,
      result.usage,
      'A resumed turn must not add prior turn counters',
    );
    const unreported = await continued('Follow up without usage');
    assert.equal(unreported.isError, false);
    assert.equal(unreported.usage, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test('visible fork context is applied to new and recovered sessions, not an acknowledged resume', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-visible-fork-'));
  try {
    const request = {
      executable: process.execPath,
      prefix: [fixture],
      env: process.env,
      cwd,
      profileDir: path.join(cwd, 'profile'),
      rawModelId: 'fixture/model',
      instructions: 'Current policy',
      prompt: 'FORK_SEED_PROBE',
      signal: AbortSignal.timeout(20_000),
      initialContext: { text: 'FORK_INHERITED_ALPHA' },
    };
    const host: OpenCodeTurnHost = {
      authorize: () => Promise.resolve({ decision: 'deny' }),
      emit: () => undefined,
    };
    const first = await runOpenCodeTurn(request, host);
    assert.equal(first.isError, false);
    assert.match(
      first.responseText,
      /Current policy[\s\S]*FORK_INHERITED_ALPHA[\s\S]*FORK_SEED_PROBE/,
    );
    const resumed = await runOpenCodeTurn(
      {
        ...request,
        sessionId: first.sessionId,
        initialContext: {
          ...request.initialContext,
          appliedSessionId: first.sessionId,
        },
      },
      host,
    );
    assert.equal(resumed.isError, false);
    assert.doesNotMatch(resumed.responseText, /FORK_INHERITED_ALPHA/);
    const recovered = await runOpenCodeTurn(
      {
        ...request,
        sessionId: 'missing',
        resumePolicy: 'recover',
        initialContext: {
          ...request.initialContext,
          appliedSessionId: 'missing',
        },
      },
      host,
    );
    assert.equal(recovered.isError, false);
    assert.match(recovered.responseText, /FORK_INHERITED_ALPHA/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test('fork runtime initializes lazy native metadata with an empty session and deletes only that session', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-fork-startup-'));
  const log = path.join(cwd, 'lifecycle.jsonl');
  try {
    const runtime = await startOpenCodeRuntime({
      executable: process.execPath,
      prefix: [fixture],
      cwd,
      profileDir: path.join(cwd, 'profile'),
      env: {
        ...process.env,
        OPENCODE_FIXTURE_LAZY_PLUGIN: '1',
        OPENCODE_FIXTURE_LIFECYCLE_LOG: log,
        OPENCODE_AUTH_CONTENT: '{}',
      },
      signal: AbortSignal.timeout(10000),
      forkScope: {
        sourceSessionId: 'untouched-source',
        sourceCwd: cwd,
        destinationCwd: cwd,
        createdAfter: Date.now(),
      },
      authorize: () => Promise.resolve({ decision: 'deny' }),
      onUpdate: () => undefined,
    });
    try {
      runtime.assertApprovalReady();
      assert.deepEqual(
        await runtime.readMetadata('/sessions/untouched-source'),
        { id: 'untouched-source' },
      );
    } finally {
      await runtime.close();
    }
    const lifecycle = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line): { method: string; sessionId?: string } => {
        const row: unknown = JSON.parse(line);
        assert.ok(row !== null && typeof row === 'object');
        assert.ok('method' in row && typeof row.method === 'string');
        if ('sessionId' in row) {
          assert.ok(typeof row.sessionId === 'string');
          return { method: row.method, sessionId: row.sessionId };
        }
        return { method: row.method };
      });
    assert.equal(
      lifecycle.filter((row) => row.method === 'session/new').length,
      1,
    );
    assert.deepEqual(
      lifecycle.filter((row) => row.method === 'session/delete'),
      [{ method: 'session/delete', sessionId: 'opencode-fixture' }],
    );
    assert.equal(
      lifecycle.some((row) => row.sessionId === 'untouched-source'),
      false,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
