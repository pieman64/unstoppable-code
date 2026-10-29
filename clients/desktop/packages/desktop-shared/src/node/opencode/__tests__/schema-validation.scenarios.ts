import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createOpenCodeSchemaValidator } from '../schema-validation';
import { directory, validate } from './schema-validation.fixture';

const malicious = { type: 'string', pattern: '^(a+)+$' };
const hostileInput = 'a'.repeat(32) + '!';
const signal = (): AbortSignal => new AbortController().signal;

void test('schema CPU deadline leaves the host responsive and drains the worker before reuse', async () => {
  let beats = 0;
  const timer = setInterval(() => beats++, 20);
  const start = Date.now();
  try {
    assert.equal(await validate(malicious, hostileInput, signal()), false);
    assert.ok(Date.now() - start < 4000);
    assert.ok(beats >= 10, `Only ${beats} host heartbeats during validation`);
    assert.equal(await validate({ type: 'string' }, 'valid', signal()), true);
  } finally {
    clearInterval(timer);
  }
});

void test('cancellation of running and queued work is prompt and never authorizes', async () => {
  const active = new AbortController();
  const queued = new AbortController();
  const first = validate(malicious, hostileInput, active.signal);
  const second = validate({ type: 'string' }, 'valid', queued.signal);
  queued.abort();
  assert.equal(await second, false);
  active.abort();
  assert.equal(await first, false);
  assert.equal(await validate({ type: 'string' }, 'valid', signal()), true);
  assert.equal(
    await validate({ type: 'string' }, 'valid', active.signal),
    false,
  );
});

void test('schema versions preserve tuples, local refs and unevaluated properties', async () => {
  for (const dialect of [
    undefined,
    'https://json-schema.org/draft/2020-12/schema',
  ]) {
    const schema = {
      ...(dialect ? { $schema: dialect } : {}),
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'integer' }],
      items: false,
      minItems: 2,
    };
    assert.equal(await validate(schema, ['valid', 42], signal()), true);
    assert.equal(await validate(schema, [42, 'invalid'], signal()), false);
    assert.equal(
      await validate(schema, ['valid', 42, 'extra'], signal()),
      false,
    );
  }
  for (const protocol of ['http', 'https']) {
    for (const fragment of ['', '#']) {
      const older = {
        $schema: `${protocol}://json-schema.org/draft-07/schema${fragment}`,
        type: 'array',
        items: [{ type: 'string' }],
        additionalItems: false,
      };
      assert.equal(
        await validate(older, ['valid'], signal()),
        true,
        older.$schema,
      );
      assert.equal(await validate(older, ['valid', 'extra'], signal()), false);
    }
  }
  const reference = {
    $schema: 'https://json-schema.org/draft/2019-09/schema',
    $defs: {
      named: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
    $ref: '#/$defs/named',
    unevaluatedProperties: false,
  };
  assert.equal(await validate(reference, { name: 'valid' }, signal()), true);
  assert.equal(
    await validate(reference, { name: 'valid', extra: true }, signal()),
    false,
  );
});

void test('invalid, async, remote-reference and unsupported schemas fail closed', async () => {
  for (const schema of [
    { $schema: 'https://unknown.invalid/schema', type: 'string' },
    { $async: true, type: 'string' },
    { $ref: 'https://untrusted.invalid/schema' },
    { type: 'invalid' },
    { type: 'string', format: 'unknown-format' },
  ])
    assert.equal(await validate(schema, 'value', signal()), false);
});

void test('payload bounds reject huge, cyclic, deep and non-JSON inputs before worker admission', async () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let deep: unknown = 'end';
  for (let i = 0; i < 70; i++) deep = [deep];
  let getterRan = false;
  const accessor = {
    get value(): string {
      getterRan = true;
      return 'value';
    },
  };
  const customJson = Object.defineProperty({}, 'toJSON', {
    value: () => {
      getterRan = true;
      return {};
    },
  });
  for (const input of [
    customJson,
    cycle,
    deep,
    accessor,
    new Date(),
    Array(10001),
    'x'.repeat(1024 * 1024 + 1),
    Array(10001).fill(1),
  ])
    assert.equal(await validate({}, input, signal()), false);
  assert.equal(getterRan, false);
});

void test('worker crashes, invalid messages and saturation fail closed without poisoning later requests', async () => {
  for (const [name, source] of Object.entries({
    crash: "throw new Error('fixture');",
    malformed:
      "require('node:worker_threads').parentPort.postMessage({ok:true});",
  })) {
    const file = join(directory, name + '.cjs');
    await writeFile(file, source);
    assert.equal(
      await createOpenCodeSchemaValidator(file)({}, {}, signal()),
      false,
    );
  }
  const abort = new AbortController();
  const requests = Array.from({ length: 32 }, () =>
    validate(malicious, hostileInput, abort.signal),
  );
  assert.equal(await validate({}, {}, signal()), false);
  abort.abort();
  assert.deepEqual(await Promise.all(requests), Array(32).fill(false));
  assert.equal(await validate({ type: 'string' }, 'valid', signal()), true);
});

void test('known format assertions validate valid inputs and reject invalid ones', async () => {
  const schema = { type: 'string', format: 'uuid' };
  assert.equal(
    await validate(schema, 'c96dfda7-9ea2-4919-8be1-9d1c149c908a', signal()),
    true,
  );
  assert.equal(await validate(schema, 'not-a-uuid', signal()), false);
});

void test('vendor annotations do not invalidate standard schemas or disable format assertions', async () => {
  for (const $schema of [
    undefined,
    'https://json-schema.org/draft/2019-09/schema',
    'http://json-schema.org/draft-07/schema',
  ]) {
    const schema = {
      ...($schema ? { $schema } : {}),
      type: 'object',
      'x-vendor': { format: 'annotation-only' },
      properties: {
        value: {
          type: 'string',
          format: 'uuid',
          markdownDescription: 'Identifier',
          enumDescriptions: ['Identifier'],
        },
      },
      required: ['value'],
    };
    assert.equal(
      await validate(
        schema,
        { value: 'c96dfda7-9ea2-4919-8be1-9d1c149c908a' },
        signal(),
      ),
      true,
    );
    assert.equal(await validate(schema, { value: 'invalid' }, signal()), false);
    assert.equal(
      await validate(
        {
          ...schema,
          properties: {
            value: {
              type: 'string',
              format: 'unknown-format',
              'x-vendor': true,
            },
          },
        },
        { value: 'anything' },
        signal(),
      ),
      false,
    );
  }
});
