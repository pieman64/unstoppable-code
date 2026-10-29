import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import {
  createNativeResourceReader,
  validateProcessIdentities,
} from './process-resources.mjs';

const execute = promisify(execFile);
const QUANTITIES = ['nettopTcpUdpReceivedBytes', 'nettopTcpUdpSentBytes'];

/** One non-delta, process-summary TCP+UDP sample, not lifetime traffic or a rate. */
export function parseNettopOutput(stdout) {
  const lines = String(stdout).replace(/\n$/, '').split('\n');
  if (lines.shift() !== ',bytes_in,bytes_out,')
    throw new Error('Invalid nettop header');
  const rows = new Map();
  for (const line of lines) {
    const f = line.split(',');
    const match = /^.+\.([1-9]\d*)$/.exec(f[0]);
    const pid = Number(match?.[1]);
    if (
      f.length !== 4 ||
      f[3] !== '' ||
      !Number.isSafeInteger(pid) ||
      pid > 2147483647 ||
      rows.has(pid) ||
      f
        .slice(1, 3)
        .some(
          (value) =>
            !/^(0|[1-9]\d*)$/.test(value) ||
            BigInt(value) > 18446744073709551615n,
        )
    ) {
      throw new Error('Invalid or duplicate nettop process summary');
    }
    rows.set(pid, f.slice(1, 3));
  }
  return rows;
}

export async function createNetworkResourceReader({
  platform = process.platform,
  resourceReader,
  run = execute,
  nettopPath = '/usr/bin/nettop',
} = {}) {
  if (platform !== 'darwin')
    return { unavailable: `nettop unsupported on ${platform}` };
  const native = resourceReader ?? (await createNativeResourceReader());
  if (native.unavailable) return native;
  const collectorSha256 = createHash('sha256')
    .update(await readFile(new URL('./network-resources.mjs', import.meta.url)))
    .digest('hex');
  return {
    async read(identities) {
      identities = validateProcessIdentities(identities);
      const monotonicStartMs = performance.now();
      const startedAt = new Date().toISOString();
      let before = null,
        initialValidationError = null;
      try {
        before = await native.read(identities);
      } catch (error) {
        initialValidationError = error.message;
      }
      const valid = (sample, identity) =>
        sample?.processes.some(
          (row) =>
            row.pid === identity.pid &&
            row.startId === identity.startId &&
            row.state === 'live',
        );
      const eligible = identities.filter((identity) => valid(before, identity));
      const args = [
        '-n',
        '-P',
        '-L',
        '1',
        '-x',
        '-J',
        'bytes_in,bytes_out',
        ...eligible.flatMap(({ pid }) => ['-p', String(pid)]),
      ];
      let rawOutput = null,
        stderr = null,
        nettopSha256 = null,
        failure = null,
        rows;
      if (eligible.length) {
        try {
          nettopSha256 = createHash('sha256')
            .update(await readFile(nettopPath))
            .digest('hex');
          // Qualification defaults to /usr/bin/nettop and records its hash to identify
          // the macOS system observer, not an app override or login-PATH installation.
          // This standalone collector bypasses app binary/environment helpers; revisit
          // that choice if it moves into product runtime.
          const output = await run(nettopPath, args, {
            encoding: 'utf8',
            timeout: 10_000,
            maxBuffer: 8 * 1024 * 1024,
          });
          rawOutput = output.stdout;
          stderr = output.stderr ?? '';
          rows = parseNettopOutput(rawOutput);
          if (
            [...rows.keys()].some(
              (pid) => !eligible.some((row) => row.pid === pid),
            )
          ) {
            throw new Error('Unexpected nettop PID');
          }
        } catch (error) {
          rawOutput ??= error.stdout ?? null;
          stderr ??= error.stderr ?? null;
          failure = {
            status: error.code === 'ENOENT' ? 'unsupported' : 'error',
            reason: 'nettop',
            message: error.message,
            code: error.code ?? null,
          };
        }
      }
      let after = null,
        revalidationError = null;
      try {
        after = await native.read(identities);
      } catch (error) {
        revalidationError = error.message;
      }
      const processes = identities.map((identity) => {
        let unknown = failure;
        if (!valid(before, identity) || !after || !valid(after, identity)) {
          unknown = { status: 'error', reason: 'identity_unavailable' };
        } else if (!unknown && !rows?.has(identity.pid)) {
          unknown = { status: 'unavailable', reason: 'pid_absent' };
        }
        return {
          pid: identity.pid,
          startId: identity.startId,
          quantities: Object.fromEntries(
            QUANTITIES.map((key, i) => [
              key,
              unknown
                ? { ...unknown, value: null }
                : { status: 'ok', value: rows.get(identity.pid)[i] },
            ]),
          ),
        };
      });
      return {
        processes,
        before,
        initialValidationError,
        after,
        revalidationError,
        failure,
        startedAt,
        monotonicStartMs,
        monotonicEndMs: performance.now(),
        rawOutput,
        stderr,
        command: nettopPath,
        args,
        nettopSha256,
        collectorSha256,
      };
    },
  };
}
