import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { EventEmitter, once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createNativeResourceReader } from './process-resources.mjs';
import {
  createNetworkResourceReader,
  parseNettopOutput,
} from './network-resources.mjs';

const identity = { pid: 42, startId: '123.000456' };
const csv = ',bytes_in,bytes_out,\nnode.42,131072,131072,\n';
const received = (sample) =>
  sample.processes[0].quantities.nettopTcpUdpReceivedBytes;

test('nettop strict summaries retain byte precision and absence, never infer zero', () => {
  assert.deepEqual(parseNettopOutput(csv).get(42), ['131072', '131072']);
  assert.equal(parseNettopOutput(',bytes_in,bytes_out,\n').size, 0);
  assert.deepEqual(
    parseNettopOutput(csv.replace('131072,131072', '0,9007199254740993')).get(
      42,
    ),
    ['0', '9007199254740993'],
  );
  assert.deepEqual(
    parseNettopOutput(
      ',bytes_in,bytes_out,\nname.with.dots.2147483647,18446744073709551615,0,\n',
    ).get(2147483647),
    ['18446744073709551615', '0'],
  );
  for (const output of [
    '',
    'bytes_in,bytes_out\n',
    `${csv}node.42,1,1,\n`,
    csv.replace('131072', '-1'),
    csv.replace('131072', '1KiB'),
    csv.replace('131072', '18446744073709551616'),
    csv.replace('42', '2147483648'),
    csv.replace('131072', ''),
    csv.replace('131072', '01'),
    csv.replace(/,$/m, ''),
    `${csv}tcp4 localhost,1,1,\n`,
    csv.replace('131072', '+1'),
    csv.replace('131072', '1.0'),
    csv.replace('42', '0'),
    csv.replace('42', '01'),
    csv.replace('131072,131072', '1,2,3'),
    csv.replace('131072', ' 1'),
    csv.replace('131072', '1e3'),
    csv.replace('131072,131072', '1,18446744073709551616'),
    `${csv}\nnode.43,1,2,\n`,
    csv.replace(/,\n$/, ', \n'),
    `${csv}\n`,
  ]) {
    assert.throws(() => parseNettopOutput(output), JSON.stringify(output));
  }
});

test('network reader brackets identities and retains raw failures, scope and hashes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'network-reader-'));
  try {
    const file = path.join(dir, 'nettop');
    await writeFile(file, 'fixture');
    let output = csv,
      failure,
      afterError,
      beforePresent = true,
      afterState = 'live',
      afterStart = identity.startId;
    const calls = [];
    let reads = 0;
    const reader = await createNetworkResourceReader({
      platform: 'darwin',
      nettopPath: file,
      resourceReader: {
        read: async (identities) => {
          reads++;
          if (reads % 2 === 0 && afterError) throw new Error(afterError);
          return {
            processes: (reads % 2 === 1 && !beforePresent
              ? []
              : identities
            ).map((row) => ({
              ...row,
              state: reads % 2 === 0 ? afterState : 'live',
              startId: reads % 2 === 0 ? afterStart : row.startId,
            })),
            rawOutput: 'native',
          };
        },
      },
      run: async (file, args, options) => {
        calls.push({ file, args, options });
        if (failure) throw failure;
        return { stdout: output, stderr: '' };
      },
    });
    let sample = await reader.read([identity]);
    assert.equal(received(sample).value, '131072');
    assert.deepEqual(calls[0].args, [
      '-n',
      '-P',
      '-L',
      '1',
      '-x',
      '-J',
      'bytes_in,bytes_out',
      '-p',
      '42',
    ]);
    assert.equal(sample.rawOutput, csv);
    assert.equal(sample.command, file);
    assert.ok(Date.parse(sample.startedAt));
    assert.deepEqual(calls[0].options, {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(sample.before.rawOutput, 'native');
    assert.equal(sample.after.rawOutput, 'native');
    assert.match(sample.nettopSha256, /^[a-f0-9]{64}$/);
    assert.match(sample.collectorSha256, /^[a-f0-9]{64}$/);
    assert.ok(sample.monotonicEndMs >= sample.monotonicStartMs);
    sample = await reader.read([identity, { ...identity, pid: 43 }]);
    assert.equal(received(sample).value, '131072');
    assert.equal(
      sample.processes[1].quantities.nettopTcpUdpSentBytes.reason,
      'pid_absent',
    );
    output = ',bytes_in,bytes_out,\n';
    assert.equal(received(await reader.read([identity])).reason, 'pid_absent');
    output = csv.replace('42', '43');
    assert.equal(received(await reader.read([identity])).status, 'error');
    output = 'garbled partial output';
    sample = await reader.read([identity]);
    assert.equal(received(sample).status, 'error');
    assert.equal(sample.rawOutput, output);
    failure = Object.assign(new Error('missing'), {
      code: 'ENOENT',
      stderr: 'missing binary',
    });
    sample = await reader.read([identity]);
    assert.equal(received(sample).status, 'unsupported');
    assert.equal(sample.stderr, 'missing binary');
    failure = Object.assign(new Error('permission denied'), {
      code: 70,
      stdout: 'partial',
      stderr: 'NStatManagerCreate failed',
    });
    sample = await reader.read([identity]);
    assert.equal(received(sample).status, 'error');
    assert.equal(sample.rawOutput, 'partial');
    assert.equal(sample.failure.code, 70);
    failure = null;
    output = csv;
    afterStart = '124.000456';
    assert.equal(
      received(await reader.read([identity])).reason,
      'identity_unavailable',
    );
    afterStart = identity.startId;
    afterState = 'zombie';
    assert.equal(received(await reader.read([identity])).value, null);
    afterState = 'live';
    afterError = 'helper failed';
    sample = await reader.read([identity]);
    assert.equal(sample.revalidationError, 'helper failed');
    assert.equal(received(sample).value, null);
    afterError = null;
    beforePresent = false;
    const beforeCount = calls.length;
    assert.equal(
      received(await reader.read([identity])).reason,
      'identity_unavailable',
    );
    assert.equal(
      calls.length,
      beforeCount,
      'no nettop invocation for absent identity',
    );
    beforePresent = true;
    const count = calls.length;
    assert.equal((await reader.read([])).processes.length, 0);
    assert.equal(calls.length, count);
    await rm(file);
    sample = await reader.read([identity]);
    assert.equal(received(sample).status, 'unsupported');
    assert.equal(received(sample).value, null);
    assert.equal(sample.failure.code, 'ENOENT');
    assert.equal(calls.length, count, 'do not invoke a missing executable');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.match(
    (await createNetworkResourceReader({ platform: 'win32' })).unavailable,
    /unsupported/,
  );
  assert.deepEqual(
    await createNetworkResourceReader({
      platform: 'darwin',
      resourceReader: { unavailable: 'native unavailable' },
    }),
    { unavailable: 'native unavailable' },
  );
});

test('initial identity read failures remain explicit unknown samples', async () => {
  const reader = await createNetworkResourceReader({
    platform: 'darwin',
    resourceReader: {
      read: async () => {
        throw new Error('helper timeout');
      },
    },
    run: async () => assert.fail('must not invoke nettop without identities'),
  });
  const sample = await reader.read([identity]);
  assert.equal(sample.initialValidationError, 'helper timeout');
  assert.equal(sample.before, null);
  assert.equal(received(sample).status, 'error');
  assert.equal(received(sample).value, null);
  await assert.rejects(reader.read([identity, identity]), /duplicate/);
  for (const invalid of [
    null,
    Array(1),
    [{}],
    [{ ...identity, pid: 0 }],
    [{ ...identity, startId: '123.1' }],
    [{ ...identity, startId: '18446744073709551616.000000' }],
    Array(1025).fill(identity),
  ]) {
    await assert.rejects(reader.read(invalid));
  }
  const boundary = Array.from({ length: 1024 }, (_, index) => ({
    ...identity,
    pid: index + 1,
  }));
  assert.equal((await reader.read(boundary)).processes.length, 1024);
});

test('mixed identity states stay separate and caller mutation cannot retarget a read', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'network-identities-'));
  try {
    const file = path.join(dir, 'nettop');
    await writeFile(file, 'fixture');
    let reads = 0;
    const calls = [];
    const reader = await createNetworkResourceReader({
      platform: 'darwin',
      nettopPath: file,
      resourceReader: {
        read: async (identities) => {
          calls.push(identities);
          return {
            processes: identities
              .filter((row) => reads === 0 || row.pid !== 44)
              .map((row) => ({
                ...row,
                state: row.pid === 43 ? 'zombie' : 'live',
              })),
            sequence: reads++,
          };
        },
      },
      run: async (_, args) => {
        assert.deepEqual(args.slice(7), ['-p', '42', '-p', '44']);
        return {
          stdout:
            ',bytes_in,bytes_out,\nnode.42,0,18446744073709551615,\nnode.44,1,2,\n',
          stderr: 'diagnostic',
        };
      },
    });
    const input = [42, 43, 44].map((pid) => ({ ...identity, pid }));
    const pending = reader.read(input);
    input[0].pid = 99;
    input[0].startId = '124.000456';
    input.pop();
    const sample = await pending;
    assert.equal(sample.processes.length, 3);
    assert.equal(received(sample).status, 'ok');
    assert.equal(received(sample).value, '0');
    assert.equal(
      sample.processes[0].quantities.nettopTcpUdpSentBytes.value,
      '18446744073709551615',
    );
    assert.equal(sample.stderr, 'diagnostic');
    for (const row of sample.processes.slice(1)) {
      for (const quantity of Object.values(row.quantities)) {
        assert.deepEqual(quantity, {
          status: 'error',
          reason: 'identity_unavailable',
          value: null,
        });
      }
    }
    for (const identities of calls) {
      assert.deepEqual(
        identities.map((row) => row.pid),
        [42, 43, 44],
      );
    }
    assert.equal(sample.before.sequence, 0);
    assert.equal(sample.after.sequence, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function assertNetworkEchoDelta(transfer, expectedDelta) {
  const native = await createNativeResourceReader();
  assert.ok(!native.unavailable, native.unavailable);
  const self = (await native.readTree(process.pid)).processes.find(
    (row) => row.pid === process.pid,
  );
  assert.ok(self);
  const reader = await createNetworkResourceReader({ resourceReader: native });
  await transfer(0);
  const before = await reader.read([self]);
  await transfer(1);
  const after = await reader.read([self]);
  for (const name of ['nettopTcpUdpReceivedBytes', 'nettopTcpUdpSentBytes']) {
    const a = before.processes[0].quantities[name],
      b = after.processes[0].quantities[name];
    assert.equal(a.status, 'ok', JSON.stringify(before));
    assert.equal(b.status, 'ok', JSON.stringify(after));
    assert.equal(BigInt(b.value) - BigInt(a.value), expectedDelta, name);
  }
}

async function withTcpEcho(
  run,
  {
    serverFactory = createServer,
    connectionFactory = createConnection,
    timeoutMs = 25_000,
  } = {},
) {
  const controller = new AbortController();
  const { signal } = controller;
  let fail;
  const failure = new Promise((_, reject) => {
    fail = (error) => {
      reject(error);
      controller.abort(error);
    };
  });
  const sockets = new Set();
  const server = serverFactory((socket) => {
    sockets.add(socket);
    socket.on('error', fail);
    socket.once('close', () => {
      sockets.delete(socket);
      socket.off('error', fail);
    });
    if (signal.aborted) {
      socket.destroy();
      return;
    }
    socket.pipe(socket);
  });
  server.on('error', fail);
  let client;
  const deadline = setTimeout(
    () => fail(new Error('TCP qualification exceeded its deadline')),
    timeoutMs,
  );
  try {
    return await Promise.race([
      failure,
      (async () => {
        const listening = once(server, 'listening', { signal });
        try {
          server.listen(0, '127.0.0.1');
        } catch (error) {
          fail(error);
        }
        await listening;
        signal.throwIfAborted();
        client = connectionFactory(server.address().port, '127.0.0.1');
        client.on('error', fail);
        await once(client, 'connect', { signal });
        signal.throwIfAborted();
        const transfer = (batch) => {
          signal.throwIfAborted();
          return new Promise((resolve, reject) => {
            const payload = Buffer.alloc(65536, batch);
            const chunks = [];
            let received = 0;
            const finish = (error) => {
              client.off('data', onData);
              client.off('close', onClose);
              signal.removeEventListener('abort', onAbort);
              if (error) reject(error);
              else resolve();
            };
            const onClose = () =>
              finish(new Error('TCP closed before echo completed'));
            const onAbort = () => finish(signal.reason);
            const onData = (data) => {
              chunks.push(data);
              received += data.length;
              if (received >= payload.length) {
                try {
                  assert.ok(
                    Buffer.concat(chunks).equals(payload),
                    'TCP echo payload mismatch',
                  );
                  finish();
                } catch (error) {
                  finish(error);
                }
              }
            };
            client.on('data', onData);
            client.once('close', onClose);
            signal.addEventListener('abort', onAbort, { once: true });
            try {
              client.write(payload);
            } catch (error) {
              finish(error);
            }
          });
        };
        return run(transfer);
      })(),
    ]);
  } finally {
    clearTimeout(deadline);
    controller.abort();
    await Promise.all(
      [...sockets, ...(client ? [client] : [])].map(async (socket) => {
        const closed = socket.closed
          ? Promise.resolve()
          : new Promise((resolve) => socket.once('close', resolve));
        socket.destroy();
        await closed;
        socket.off('error', fail);
      }),
    );
    await new Promise((resolve) => server.close(resolve));
    server.off('error', fail);
  }
}

test('TCP late-collector deadline rejects and prevents subsequent traffic', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const server = new EventEmitter();
  server.listen = () => {
    server.listening = true;
    queueMicrotask(() => server.emit('listening'));
  };
  server.address = () => ({ port: 12345 });
  server.close = (callback) => {
    server.listening = false;
    callback?.();
  };
  const client = new EventEmitter();
  let writes = 0;
  client.write = (payload) => {
    writes++;
    queueMicrotask(() => client.emit('data', payload));
  };
  client.destroy = () => {
    client.destroyed = true;
    client.closed = true;
    queueMicrotask(() => client.emit('close'));
  };
  let resume;
  const pending = withTcpEcho(
    async (transfer) => {
      await transfer(0);
      await new Promise((resolve) => {
        resume = resolve;
        context.mock.timers.tick(25_000);
      });
      await transfer(1);
    },
    {
      serverFactory: () => server,
      connectionFactory: () => {
        queueMicrotask(() => client.emit('connect'));
        return client;
      },
    },
  );
  await assert.rejects(pending, /deadline/);
  resume();
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(writes, 1, 'no writes after cleanup');
  assert.equal(client.destroyed, true);
  assert.equal(server.listening, false);
  for (const socket of [server, client]) {
    for (const event of ['listening', 'connect', 'data', 'close', 'error']) {
      assert.equal(socket.listenerCount(event), 0, `pending ${event} listener`);
    }
  }
});

test(
  'live nettop bytes respond exactly to a bounded same-process TCP echo',
  { skip: process.platform !== 'darwin', timeout: 30_000 },
  async () => {
    await withTcpEcho((transfer) => assertNetworkEchoDelta(transfer, 131072n));
  },
);

test('TCP transfer errors and fragmented success remove pending waiters', async () => {
  for (const [mode, expectedError, expectedWrites] of [
    ['send-error', /write failure/, 1],
    ['closed', /closed/, 1],
    ['corrupt', { code: 'ERR_ASSERTION' }, 1],
    ['success', undefined, 2],
  ]) {
    const server = new EventEmitter();
    server.listen = () => queueMicrotask(() => server.emit('listening'));
    server.address = () => ({ port: 12345 });
    server.close = (callback) => callback();
    const client = new EventEmitter();
    client.destroy = () => {
      client.closed = true;
      queueMicrotask(() => client.emit('close'));
    };
    let writes = 0;
    client.write = (payload) => {
      writes++;
      if (mode === 'send-error') throw new Error('injected write failure');
      queueMicrotask(() => {
        if (mode === 'closed') client.emit('close');
        else if (mode === 'corrupt')
          client.emit('data', Buffer.alloc(65536, 99));
        else {
          client.emit('data', payload.subarray(0, 8192));
          client.emit('data', payload.subarray(8192));
        }
      });
    };
    const pending = withTcpEcho(
      async (transfer) => {
        await transfer(0);
        await transfer(1);
        return 'complete';
      },
      {
        serverFactory: () => server,
        connectionFactory: () => {
          queueMicrotask(() => client.emit('connect'));
          return client;
        },
      },
    );
    if (expectedError) await assert.rejects(pending, expectedError);
    else assert.equal(await pending, 'complete');
    assert.equal(writes, expectedWrites, `${mode} transfer attempts`);
    assert.equal(client.closed, true);
    for (const socket of [server, client]) {
      for (const event of ['listening', 'connect', 'data', 'close', 'error']) {
        assert.equal(
          socket.listenerCount(event),
          0,
          `pending ${event} listener`,
        );
      }
    }
  }
});

test('TCP accepts queued during cleanup are destroyed instead of keeping the server open', async () => {
  const server = new EventEmitter();
  server.listen = () => queueMicrotask(() => server.emit('listening'));
  server.address = () => ({ port: 12345 });
  const late = new EventEmitter();
  let echoed = false;
  late.pipe = () => {
    echoed = true;
  };
  late.destroy = () => {
    late.closed = true;
    queueMicrotask(() => late.emit('close'));
  };
  server.close = (callback) => {
    assert.equal(late.closed, true, 'late accepted socket must be destroyed');
    callback();
  };
  const client = new EventEmitter();
  let accept;
  client.destroy = () =>
    queueMicrotask(() => {
      accept(late);
      client.closed = true;
      client.emit('close');
    });
  await withTcpEcho(async () => {}, {
    serverFactory: (onConnection) => {
      accept = onConnection;
      return server;
    },
    connectionFactory: () => {
      queueMicrotask(() => client.emit('connect'));
      return client;
    },
  });
  assert.equal(echoed, false, 'must not start echo during cleanup');
  assert.equal(late.listenerCount('error'), 0);
  assert.equal(late.listenerCount('close'), 0);
});

async function withUdpEcho(
  run,
  { socketFactory = createSocket, timeoutMs = 25_000 } = {},
) {
  const server = socketFactory('udp4');
  const client = socketFactory('udp4');
  const controller = new AbortController();
  const { signal } = controller;
  let fail;
  const failure = new Promise((_, reject) => {
    fail = (error) => {
      reject(error);
      controller.abort(error);
    };
  });
  server.on('error', fail);
  client.on('error', fail);
  const onMessage = (message, remote) => {
    if (signal.aborted) return;
    try {
      server.send(message, remote.port, remote.address, (error) => {
        if (error) fail(error);
      });
    } catch (error) {
      fail(error);
    }
  };
  server.on('message', onMessage);
  const waitFor = (socket, event, action) => {
    signal.throwIfAborted();
    const pending = once(socket, event, { signal });
    try {
      action();
    } catch (error) {
      fail(error);
    }
    return pending;
  };
  const deadline = setTimeout(
    () => fail(new Error('UDP qualification exceeded its deadline')),
    timeoutMs,
  );
  try {
    return await Promise.race([
      failure,
      (async () => {
        await waitFor(server, 'listening', () => server.bind(0, '127.0.0.1'));
        await waitFor(client, 'connect', () =>
          client.connect(server.address().port, '127.0.0.1'),
        );
        signal.throwIfAborted();
        const transfer = async (batch) => {
          for (let index = 0; index < 4; index++) {
            signal.throwIfAborted();
            const payload = Buffer.alloc(4096, batch * 4 + index);
            const [message] = await waitFor(client, 'message', () =>
              client.send(payload, (error) => {
                if (error) fail(error);
              }),
            );
            assert.deepEqual(message, payload);
          }
        };
        return run(transfer);
      })(),
    ]);
  } finally {
    clearTimeout(deadline);
    controller.abort();
    server.off('message', onMessage);
    await Promise.all(
      [server, client].map(async (socket) => {
        try {
          await promisify(socket.close).call(socket);
        } catch (error) {
          if (error.code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') throw error;
        }
        socket.off('error', fail);
      }),
    );
  }
}

test('UDP send failure and late-collector deadline clean up without restarting traffic', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const mode of ['send-error', 'deadline']) {
    const sockets = [];
    const failure = new Error('injected send failure');
    let sends = 0,
      resume;
    const socketFactory = () => {
      const socket = new EventEmitter();
      socket.bind = () => queueMicrotask(() => socket.emit('listening'));
      socket.connect = () => queueMicrotask(() => socket.emit('connect'));
      socket.address = () => ({ port: 12345 });
      socket.send = (payload, callback) => {
        sends++;
        if (mode === 'send-error') callback(failure);
        else queueMicrotask(() => socket.emit('message', payload));
      };
      socket.close = (callback) => {
        socket.closed = true;
        callback();
      };
      sockets.push(socket);
      return socket;
    };
    const pending = withUdpEcho(
      async (transfer) => {
        await transfer(0);
        await new Promise((resolve) => {
          resume = resolve;
          context.mock.timers.tick(25_000);
        });
        await transfer(1);
      },
      { socketFactory },
    );
    await assert.rejects(
      pending,
      mode === 'send-error' ? /injected send/ : /deadline/,
    );
    resume?.();
    await new Promise((resolve) => queueMicrotask(resolve));
    assert.equal(
      sends,
      mode === 'send-error' ? 1 : 4,
      'no sends after cleanup',
    );
    for (const socket of sockets) {
      assert.equal(socket.closed, true);
      for (const event of ['message', 'listening', 'connect', 'error']) {
        assert.equal(
          socket.listenerCount(event),
          0,
          `pending ${event} listener`,
        );
      }
    }
  }
});

test('UDP bind completion racing failure cannot connect or echo after cancellation', async () => {
  const sockets = [];
  let actions = 0;
  const socketFactory = () => {
    const socket = new EventEmitter();
    socket.bind = () =>
      queueMicrotask(() => {
        socket.emit('listening');
        socket.emit('error', new Error('bind completion failure'));
        socket.emit('message', Buffer.from('late'), {
          port: 12345,
          address: '127.0.0.1',
        });
      });
    socket.address = () => ({ port: 12345 });
    socket.connect = socket.send = () => {
      actions++;
    };
    socket.close = (callback) => {
      socket.closed = true;
      callback();
    };
    sockets.push(socket);
    return socket;
  };
  await assert.rejects(
    withUdpEcho(() => assert.fail('must not run'), { socketFactory }),
    /bind completion failure/,
  );
  assert.equal(actions, 0, 'must not connect or echo after cancellation');
  assert.equal(sockets[1].listenerCount('connect'), 0);
  for (const socket of sockets) assert.equal(socket.closed, true);
});

test(
  'live nettop bytes respond exactly to a bounded same-process UDP echo',
  { skip: process.platform !== 'darwin', timeout: 30_000 },
  async () => {
    await withUdpEcho((transfer) => assertNetworkEchoDelta(transfer, 32768n));
  },
);
