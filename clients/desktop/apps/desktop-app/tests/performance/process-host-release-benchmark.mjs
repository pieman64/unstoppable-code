#!/usr/bin/env electron

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, utilityProcess } from 'electron';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../../../..');
const workerPath = path.join(
  repoRoot,
  'out',
  'main',
  'pipeline-process-host-worker.js',
);
const outputPath =
  process.env.CANOPY_PROCESS_HOST_BENCHMARK_OUTPUT ??
  path.join(repoRoot, '.performance', 'desktop', 'process-host-release.json');
const repetitions = Number.parseInt(
  process.env.CANOPY_PROCESS_HOST_BENCHMARK_REPETITIONS ?? '20',
  10,
);
const concurrency = 6;
const bytesPerProcess = 1024 * 1024;
const chunkBytes = 4 * 1024;
const heartbeatIntervalMs = 5;
const sampleIntervalMs = 10;
const nodeBinary = process.env.PROCESS_HOST_BENCHMARK_NODE_BINARY;
if (!nodeBinary) {
  throw new Error('PROCESS_HOST_BENCHMARK_NODE_BINARY must be set.');
}
const childScript = [
  `const chunk = 'x'.repeat(${String(chunkBytes)});`,
  `for (let sent = 0; sent < ${String(bytesPerProcess)}; sent += chunk.length)`,
  '  process.stdout.write(chunk);',
].join('\n');

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((percentileValue / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)] ?? 0;
}

function summarize(samples) {
  const field = (name) => samples.map((sample) => sample[name]);
  return {
    repetitions: samples.length,
    elapsed_ms: {
      median: percentile(field('elapsedMs'), 50),
      p95: percentile(field('elapsedMs'), 95),
    },
    main_heartbeat_max_ms: {
      median: percentile(field('heartbeatMaxMs'), 50),
      p95: percentile(field('heartbeatMaxMs'), 95),
    },
    main_cpu_ms: {
      median: percentile(field('mainCpuMs'), 50),
      p95: percentile(field('mainCpuMs'), 95),
    },
    main_peak_rss_mb: {
      median: percentile(field('mainPeakRssMb'), 50),
      p95: percentile(field('mainPeakRssMb'), 95),
    },
    electron_peak_working_set_mb: {
      median: percentile(field('electronPeakWorkingSetMb'), 50),
      p95: percentile(field('electronPeakWorkingSetMb'), 95),
    },
  };
}

async function measure(operation) {
  let heartbeatMaxMs = 0;
  let expectedHeartbeat = performance.now() + heartbeatIntervalMs;
  let mainPeakRss = process.memoryUsage().rss;
  let electronPeakWorkingSetKb = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    heartbeatMaxMs = Math.max(
      heartbeatMaxMs,
      Math.max(0, now - expectedHeartbeat),
    );
    expectedHeartbeat = now + heartbeatIntervalMs;
  }, heartbeatIntervalMs);
  const sample = setInterval(() => {
    mainPeakRss = Math.max(mainPeakRss, process.memoryUsage().rss);
    electronPeakWorkingSetKb = Math.max(
      electronPeakWorkingSetKb,
      app
        .getAppMetrics()
        .reduce((total, metric) => total + metric.memory.workingSetSize, 0),
    );
  }, sampleIntervalMs);
  const cpuBefore = process.cpuUsage();
  const startedAt = performance.now();
  try {
    await operation();
  } finally {
    clearInterval(heartbeat);
    clearInterval(sample);
  }
  const elapsedMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuBefore);
  return {
    elapsedMs,
    heartbeatMaxMs,
    mainCpuMs: (cpu.user + cpu.system) / 1_000,
    mainPeakRssMb: mainPeakRss / (1024 * 1024),
    electronPeakWorkingSetMb: electronPeakWorkingSetKb / 1024,
  };
}

function runDirectDrain() {
  return Promise.all(
    Array.from({ length: concurrency }, () => {
      return new Promise((resolve, reject) => {
        let received = 0;
        const child = spawn(nodeBinary, ['-e', childScript], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', (chunk) => {
          received += chunk.length;
        });
        child.stderr.resume();
        child.once('error', reject);
        child.once('close', (code) => {
          if (code !== 0) {
            reject(new Error(`Direct child exited with code ${String(code)}.`));
          } else if (received !== bytesPerProcess) {
            reject(
              new Error(
                `Direct child emitted ${String(received)} of ${String(bytesPerProcess)} bytes.`,
              ),
            );
          } else {
            resolve();
          }
        });
      });
    }),
  );
}

function createUtilityHost(tempDirectory) {
  const child = utilityProcess.fork(workerPath, [], {
    serviceName: 'pipeline-process-host-release-benchmark',
    stdio: 'pipe',
  });
  const pending = new Map();
  let exitCode;
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(chunk);
  });
  child.once('exit', (code) => {
    exitCode = code;
    for (const record of pending.values()) {
      record.reject(
        new Error(
          `Pipeline process host exited before the benchmark completed (code ${String(code)}).`,
        ),
      );
    }
    pending.clear();
  });
  child.on('message', (message) => {
    if (
      typeof message !== 'object' ||
      message === null ||
      !('type' in message)
    ) {
      return;
    }
    if (!('requestId' in message) || typeof message.requestId !== 'string') {
      return;
    }
    const record = pending.get(message.requestId);
    if (!record) return;
    if (message.type === 'output' && typeof message.data === 'string') {
      record.received += Buffer.byteLength(message.data, 'utf8');
    } else if (message.type === 'error') {
      pending.delete(message.requestId);
      record.reject(new Error(String(message.message)));
    } else if (message.type === 'result') {
      pending.delete(message.requestId);
      if (record.received !== bytesPerProcess) {
        record.reject(
          new Error(
            `Hosted child emitted ${String(record.received)} of ${String(bytesPerProcess)} bytes.`,
          ),
        );
      } else {
        record.resolve();
      }
    }
  });

  let sequence = 0;
  return {
    run() {
      if (exitCode !== undefined) {
        return Promise.reject(
          new Error(
            `Pipeline process host is not running (exit code ${String(exitCode)}).`,
          ),
        );
      }
      return Promise.all(
        Array.from({ length: concurrency }, () => {
          const requestId = `release-benchmark-${String(sequence++)}`;
          return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              pending.delete(requestId);
              reject(
                new Error(
                  `Pipeline process host timed out on ${requestId} (pid ${String(child.pid)}).`,
                ),
              );
            }, 15_000);
            pending.set(requestId, {
              received: 0,
              resolve: () => {
                clearTimeout(timeout);
                resolve();
              },
              reject: (error) => {
                clearTimeout(timeout);
                reject(error);
              },
            });
            child.postMessage({
              type: 'run',
              requestId,
              processSpec: {
                command: nodeBinary,
                args: ['-e', childScript],
              },
              options: {
                cwd: repoRoot,
                env: {},
                timeout_minutes: 1,
                logFile: path.join(tempDirectory, `${requestId}.log`),
                outputFile: path.join(tempDirectory, `${requestId}.output`),
                envFile: path.join(tempDirectory, `${requestId}.env`),
              },
            });
          });
        }),
      );
    },
    shutdown() {
      if (exitCode !== undefined) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          child.kill();
          resolve();
        }, 1_000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
        child.postMessage({ type: 'shutdown' });
      });
    },
  };
}

async function runBenchmark() {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'pipeline-process-host-release-benchmark-'),
  );
  const utilityHost = createUtilityHost(tempDirectory);
  const directSamples = [];
  const utilityHostSamples = [];

  try {
    await runDirectDrain();
    await utilityHost.run();
    for (let index = 0; index < repetitions; index += 1) {
      if (index % 2 === 0) {
        directSamples.push(await measure(runDirectDrain));
        utilityHostSamples.push(await measure(() => utilityHost.run()));
      } else {
        utilityHostSamples.push(await measure(() => utilityHost.run()));
        directSamples.push(await measure(runDirectDrain));
      }
    }
    await utilityHost.shutdown();
    const result = {
      build: 'production',
      workload: {
        repetitions,
        concurrency,
        bytes_per_process: bytesPerProcess,
        total_bytes_per_repetition: concurrency * bytesPerProcess,
      },
      direct_main_process_drain: summarize(directSamples),
      utility_process_host: summarize(utilityHostSamples),
    };
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

app
  .whenReady()
  .then(runBenchmark)
  .then(() => app.exit(0))
  .catch((error) => {
    process.stderr.write(
      `Process-host release benchmark failed: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    app.exit(1);
  });
