import {
  MODEL_LIBRARY_PROTOCOL_HEADER,
  MODEL_LIBRARY_PROTOCOL_VERSION,
} from '@canopy/protocol/models';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  runOpenCodeTurn,
  type OpenCodeTurnRequest,
  type OpenCodeTurnHost,
} from '../turn-driver';
import { readOpenCodeCapabilityBinding } from '../capability-snapshot';

const fixture = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const rawModelId = 'canopy-inference/vendor/model';
const route = {
  bindingKey: 'a'.repeat(64),
  protocol: 'anthropic-messages' as const,
  baseUrl: `http://127.0.0.1:43121/codex-gateway/${'b'.repeat(48)}`,
  model: {
    id: 'vendor/model',
    contextWindow: 128000,
    outputLimit: 4096,
    supportsVision: true,
  },
  headers: {
    'x-canopy-work-owner': 'personal',
    [MODEL_LIBRARY_PROTOCOL_HEADER]: String(MODEL_LIBRARY_PROTOCOL_VERSION),
  },
};
const host: OpenCodeTurnHost = {
  authorize: () => Promise.resolve({ decision: 'deny' }),
  emit: () => undefined,
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function property(value: unknown, ...keys: string[]): unknown {
  for (const key of keys) {
    assert.ok(isRecord(value));
    value = value[key];
  }
  return value;
}
function request(cwd: string): OpenCodeTurnRequest {
  return {
    executable: process.execPath,
    prefix: [fixture],
    env: {
      ...process.env,
      OPENCODE_AUTH_CONTENT:
        '{"unselected":{"type":"api","key":"fixture-native-secret"}}',
    },
    cwd,
    profileDir: path.join(cwd, 'profile'),
    signal: AbortSignal.timeout(15000),
    rawModelId,
    prompt: 'CONFIG_INFERENCE',
    inferenceRoute: route,
    providerConfig: {
      model: rawModelId,
      provider: {
        unselected: { options: { apiKey: 'fixture-native-secret' } },
      },
    },
  };
}

void test('managed inference uses only the explicit broker and clears native credentials', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-inference-'));
  try {
    const result = await runOpenCodeTurn(request(cwd), host);
    assert.equal(result.isError, false, result.message);
    const config: unknown = JSON.parse(result.responseText);
    assert.deepEqual(property(config, 'enabledProviders'), [
      'canopy-inference',
    ]);
    assert.equal(property(config, 'model'), rawModelId);
    assert.equal(property(config, 'smallModel'), rawModelId);
    assert.equal(property(config, 'auth'), '{}');
    const providers = property(config, 'provider');
    assert.ok(isRecord(providers));
    assert.deepEqual(Object.keys(providers), ['canopy-inference']);
    assert.equal(
      property(config, 'provider', 'canopy-inference', 'npm'),
      '@ai-sdk/anthropic',
    );
    assert.equal(
      property(config, 'provider', 'canopy-inference', 'options', 'baseURL'),
      `${route.baseUrl}/v1`,
    );
    assert.equal(
      property(
        config,
        'provider',
        'canopy-inference',
        'models',
        'vendor/model',
        'limit',
        'context',
      ),
      128000,
    );
    assert.doesNotMatch(result.responseText, /fixture-native-secret/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const version of ['', '0', '9999', '1\r\nx-header: injected'])
  void test(`managed inference rejects an unsupported model-library protocol ${JSON.stringify(version)}`, async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), 'opencode-inference-protocol-'),
    );
    try {
      const result = await runOpenCodeTurn(
        {
          ...request(cwd),
          inferenceRoute: {
            ...route,
            headers: {
              ...route.headers,
              [MODEL_LIBRARY_PROTOCOL_HEADER]: version,
            },
          },
        },
        host,
      );
      assert.equal(result.isError, true);
      assert.match(result.message, /inference route/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

void test('managed inference resumes across broker rotation but refuses a different billing identity', async () => {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), 'opencode-inference-resume-'),
  );
  try {
    const original = request(cwd);
    const first = await runOpenCodeTurn(original, host);
    assert.equal(first.isError, false, first.message);
    const rotated = {
      ...route,
      baseUrl: `http://127.0.0.1:43122/codex-gateway/${'c'.repeat(48)}`,
    };
    const resumed = await runOpenCodeTurn(
      { ...original, sessionId: first.sessionId, inferenceRoute: rotated },
      host,
    );
    assert.equal(resumed.isError, false, resumed.message);
    assert.ok(first.sessionId);
    assert.equal(
      (
        await readOpenCodeCapabilityBinding(
          original.profileDir,
          first.sessionId,
        )
      )?.generation,
      1,
    );
    assert.equal(
      (
        await readOpenCodeCapabilityBinding(
          original.profileDir,
          first.sessionId,
        )
      )?.version,
      2,
    );
    assert.equal(
      property(
        JSON.parse(resumed.responseText),
        'provider',
        'canopy-inference',
        'options',
        'baseURL',
      ),
      `${rotated.baseUrl}/v1`,
    );
    const changed = await runOpenCodeTurn(
      {
        ...original,
        sessionId: first.sessionId,
        capabilityChanges: 'announce',
        inferenceRoute: { ...rotated, bindingKey: 'd'.repeat(64) },
      },
      host,
    );
    assert.equal(
      changed.isError,
      true,
      'a billing change must not be announced as a tool change',
    );
    assert.match(changed.message, /inference route changed/i);
    const native = await runOpenCodeTurn(
      {
        ...original,
        sessionId: first.sessionId,
        capabilityChanges: 'announce',
        inferenceRoute: undefined,
      },
      host,
    );
    assert.equal(
      native.isError,
      true,
      'managed history must not silently return to native billing',
    );
    for (const file of await readdir(
      path.join(original.profileDir, 'capability-snapshots'),
    )) {
      const text = await readFile(
        path.join(original.profileDir, 'capability-snapshots', file),
        'utf8',
      );
      assert.doesNotMatch(
        text,
        /43121|43122|codex-gateway|fixture-native-secret/,
      );
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const baseUrl of [
  'https://provider.invalid',
  'http://localhost:43121/codex-gateway/' + 'b'.repeat(48),
  route.baseUrl + '?secret=1',
  route.baseUrl + '?',
  route.baseUrl + '#',
  route.baseUrl + '/responses',
])
  void test(`managed inference rejects an untrusted broker address ${baseUrl}`, async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), 'opencode-inference-address-'),
    );
    try {
      const result = await runOpenCodeTurn(
        { ...request(cwd), inferenceRoute: { ...route, baseUrl } },
        host,
      );
      assert.equal(
        result.isError,
        true,
        'untrusted endpoints must be rejected before inference',
      );
      assert.match(result.message, /inference route/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

void test('managed inference cannot change funding on an existing session even with capability announcements', async () => {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), 'opencode-inference-owner-'),
  );
  try {
    const original = request(cwd);
    const first = await runOpenCodeTurn(original, host);
    assert.equal(first.isError, false, first.message);
    const changed = await runOpenCodeTurn(
      {
        ...original,
        sessionId: first.sessionId,
        capabilityChanges: 'announce',
        inferenceRoute: { ...route, bindingKey: 'd'.repeat(64) },
      },
      host,
    );
    assert.equal(
      changed.isError,
      true,
      'changed billing identity must require a fresh session',
    );
    assert.match(changed.message, /inference route changed/i);
    assert.equal(
      changed.requestRejected,
      true,
      'changed billing identity must retain actionable refusal guidance',
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test('managed inference ignores unrelated native auth and settings references', async () => {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), 'opencode-inference-isolation-'),
  );
  try {
    const original = request(cwd);
    const result = await runOpenCodeTurn(
      {
        ...original,
        env: {
          ...original.env,
          OPENCODE_AUTH_CONTENT:
            '{"native":{"type":"wellknown","key":"remote"}}',
        },
        providerConfig: {
          provider: { native: { options: { apiKey: '{file:absent-secret}' } } },
        },
        inferenceRoute: { ...route, protocol: 'openai-responses' },
      },
      host,
    );
    assert.equal(result.isError, false, result.message);
    const config: unknown = JSON.parse(result.responseText);
    assert.equal(property(config, 'auth'), '{}');
    assert.equal(
      property(config, 'provider', 'canopy-inference', 'npm'),
      '@ai-sdk/openai',
    );
    assert.equal(
      property(config, 'provider', 'canopy-inference', 'options', 'baseURL'),
      route.baseUrl,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test('native history cannot acquire managed billing through a capability change', async () => {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), 'opencode-inference-native-'),
  );
  try {
    const original = request(cwd);
    const first = await runOpenCodeTurn(
      { ...original, inferenceRoute: undefined },
      host,
    );
    assert.equal(first.isError, false, first.message);
    const changed = await runOpenCodeTurn(
      {
        ...original,
        sessionId: first.sessionId,
        capabilityChanges: 'announce',
      },
      host,
    );
    assert.equal(changed.isError, true);
    assert.match(changed.message, /inference route changed/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test('managed history binds funding headers while allowing display attribution to change', async () => {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), 'opencode-inference-headers-'),
  );
  try {
    const original = request(cwd);
    const first = await runOpenCodeTurn(original, host);
    assert.equal(first.isError, false, first.message);
    const renamed = await runOpenCodeTurn(
      {
        ...original,
        sessionId: first.sessionId,
        inferenceRoute: {
          ...route,
          headers: { ...route.headers, 'x-canopy-workspace': 'Renamed' },
        },
      },
      host,
    );
    assert.equal(renamed.isError, false, renamed.message);
    const changed = await runOpenCodeTurn(
      {
        ...original,
        sessionId: first.sessionId,
        capabilityChanges: 'announce',
        inferenceRoute: {
          ...route,
          headers: { 'x-canopy-work-owner': 'org:changed' },
        },
      },
      host,
    );
    assert.equal(
      changed.isError,
      true,
      'funding headers must not change under a stable host key',
    );
    assert.match(changed.message, /inference route changed/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test('managed inference rejects credential headers and a mismatched model before session publication', async () => {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), 'opencode-inference-invalid-'),
  );
  try {
    let published = 0;
    const currentHost = {
      ...host,
      onSession: (): void => {
        published++;
      },
    };
    for (const input of [
      { ...request(cwd), rawModelId: 'canopy-inference/other' },
      {
        ...request(cwd),
        inferenceRoute: {
          ...route,
          headers: { authorization: 'private-secret' },
        },
      },
    ]) {
      const result = await runOpenCodeTurn(input, currentHost);
      assert.equal(result.isError, true);
      assert.match(result.message, /inference route/i);
      assert.doesNotMatch(result.message, /private-secret/);
    }
    assert.equal(published, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test('managed inference retains token usage without claiming native price estimates as app billing', async () => {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), 'opencode-inference-usage-'),
  );
  try {
    const original = request(cwd);
    const events: Record<string, unknown>[] = [];
    const result = await runOpenCodeTurn(
      {
        ...original,
        prompt: 'USAGE',
        env: { ...original.env, OPENCODE_FIXTURE_USAGE: '1' },
      },
      {
        ...host,
        emit: (event): void => {
          events.push(event);
        },
      },
    );
    assert.equal(result.isError, false, result.message);
    assert.equal(result.usage?.input_tokens, 100);
    assert.equal(result.usage?.estimated_cost_usd, undefined);
    assert.doesNotMatch(JSON.stringify(events), /estimatedCostUsd/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test('explicit managed model changes retain the native session under the same funding identity', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-model-change-'));
  try {
    const original = {
      ...request(cwd),
      inferenceRoute: {
        ...route,
        selection: { modelId: 'logical-one', fundingKey: 'f'.repeat(64) },
      },
    };
    const first = await runOpenCodeTurn(original, host);
    assert.equal(first.isError, false, first.message);
    assert.ok(first.sessionId);
    const nextRoute = {
      ...original.inferenceRoute,
      bindingKey: 'e'.repeat(64),
      model: { ...route.model, id: 'vendor/second' },
      selection: { modelId: 'logical-two', fundingKey: 'f'.repeat(64) },
    };
    const changed = await runOpenCodeTurn(
      {
        ...original,
        sessionId: first.sessionId,
        capabilityChanges: 'announce',
        rawModelId: 'canopy-inference/vendor/second',
        inferenceRoute: nextRoute,
      },
      host,
    );
    assert.equal(changed.isError, false, changed.message);
    assert.equal(changed.sessionId, first.sessionId);
    assert.equal(
      property(JSON.parse(changed.responseText), 'model'),
      'canopy-inference/vendor/second',
    );
    const binding = await readOpenCodeCapabilityBinding(
      original.profileDir,
      first.sessionId,
    );
    assert.equal(binding?.version, 3);
    assert.equal(
      property(binding, 'inferenceSelection', 'modelId'),
      'logical-two',
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const change of [
  'funding',
  'funding-only',
  'owner-header',
  'project-header',
  'same-model-route',
  'missing-selection',
  'unannounced',
] as const) {
  void test(`managed model transition refuses ${change}`, async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), 'opencode-model-refusal-'),
    );
    try {
      const selected = {
        ...route,
        selection: { modelId: 'logical-one', fundingKey: 'f'.repeat(64) },
      };
      const original = { ...request(cwd), inferenceRoute: selected };
      const first = await runOpenCodeTurn(original, host);
      assert.equal(first.isError, false, first.message);
      assert.ok(first.sessionId);
      const before = await readOpenCodeCapabilityBinding(
        original.profileDir,
        first.sessionId,
      );
      const nextRoute = {
        ...selected,
        bindingKey:
          change === 'funding-only' ? selected.bindingKey : 'e'.repeat(64),
        model:
          change === 'funding-only'
            ? selected.model
            : { ...route.model, id: 'vendor/second' },
        headers:
          change === 'owner-header'
            ? {
                ...selected.headers,
                'x-canopy-work-owner':
                  'org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              }
            : change === 'project-header'
              ? { ...selected.headers, 'x-canopy-org-project': 'project-two' }
              : selected.headers,
        selection:
          change === 'missing-selection'
            ? undefined
            : {
                modelId:
                  change === 'same-model-route' ? 'logical-one' : 'logical-two',
                fundingKey: change.startsWith('funding')
                  ? 'd'.repeat(64)
                  : 'f'.repeat(64),
              },
      };
      const changed = await runOpenCodeTurn(
        {
          ...original,
          sessionId: first.sessionId,
          capabilityChanges: change === 'unannounced' ? undefined : 'announce',
          rawModelId:
            change === 'funding-only'
              ? rawModelId
              : 'canopy-inference/vendor/second',
          inferenceRoute: nextRoute,
        },
        host,
      );
      assert.equal(changed.isError, true, `must refuse ${change}`);
      assert.match(changed.message, /inference route changed/i);
      assert.deepEqual(
        await readOpenCodeCapabilityBinding(
          original.profileDir,
          first.sessionId,
        ),
        before,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

void test('same-model resume upgrades a legacy managed binding without changing session identity', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-model-upgrade-'));
  try {
    const original = request(cwd);
    const first = await runOpenCodeTurn(original, host);
    assert.equal(first.isError, false, first.message);
    assert.ok(first.sessionId);
    assert.equal(
      (
        await readOpenCodeCapabilityBinding(
          original.profileDir,
          first.sessionId,
        )
      )?.version,
      2,
    );
    const resumed = await runOpenCodeTurn(
      {
        ...original,
        sessionId: first.sessionId,
        inferenceRoute: {
          ...route,
          selection: { modelId: 'logical-one', fundingKey: 'f'.repeat(64) },
        },
      },
      host,
    );
    assert.equal(resumed.isError, false, resumed.message);
    assert.equal(resumed.sessionId, first.sessionId);
    assert.equal(
      (
        await readOpenCodeCapabilityBinding(
          original.profileDir,
          first.sessionId,
        )
      )?.version,
      3,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const selection of [
  { modelId: 'contains whitespace', fundingKey: 'f'.repeat(64) },
  { modelId: 'valid', fundingKey: 'not-a-funding-key' },
  { modelId: 'valid', fundingKey: 'g'.repeat(64) },
]) {
  void test(`invalid managed selection is refused before publication: ${selection.modelId}/${selection.fundingKey.length}`, async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), 'opencode-invalid-selection-'),
    );
    try {
      let published = false;
      const result = await runOpenCodeTurn(
        { ...request(cwd), inferenceRoute: { ...route, selection } },
        {
          ...host,
          onSession: (): void => {
            published = true;
          },
        },
      );
      assert.equal(result.isError, true);
      assert.match(result.message, /inference route/i);
      assert.equal(published, false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

for (const supportsVision of [false, true]) {
  void test(`managed image input honors the selected route capability (${supportsVision})`, async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), 'opencode-inference-image-'),
    );
    let published = false;
    try {
      const result = await runOpenCodeTurn(
        {
          ...request(cwd),
          inferenceRoute: {
            ...route,
            model: { ...route.model, supportsVision },
          },
          promptContent: [
            { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
          ],
        },
        {
          ...host,
          onSession: () => {
            published = true;
          },
        },
      );
      assert.equal(result.isError, !supportsVision, result.message);
      if (!supportsVision) {
        assert.match(result.message, /does not support image/i);
        assert.equal(Reflect.get(result, 'requestRejected'), true);
        assert.equal(
          published,
          false,
          'unsupported content must not publish a native session',
        );
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
