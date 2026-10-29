import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { connectInspector, reserveInspectorPort } from './inspector-client.mjs';
import { renderHotspotMarkdown, summarizeCpuProfile } from './hotspots.mjs';

const CPU_SAMPLING_INTERVAL_US = 1_000;
export const DIAGNOSTIC_TRACE_STOP_TIMEOUT_MS = 30_000;
export const DIAGNOSTIC_CLEANUP_OPERATION_TIMEOUT_MS = 10_000;
const TRACE_CATEGORIES = [
  'electron',
  'ipc',
  'toplevel',
  'v8',
  'devtools.timeline',
  'blink',
  'blink.user_timing',
  'cc',
  'scheduler',
  'disabled-by-default-devtools.timeline',
];

export async function prepareDiagnosticLaunch(outputDir) {
  mkdirSync(outputDir, { recursive: true });
  const utilityCpuProfileDir = path.join(outputDir, 'utility-cpu');
  mkdirSync(utilityCpuProfileDir, { recursive: true });
  const inspectorPort = await reserveInspectorPort();
  return {
    outputDir,
    utilityCpuProfileDir,
    inspectorPort,
    electronArgs: [`--inspect=${inspectorPort}`],
  };
}

export function listUtilityCpuProfiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.cpuprofile'))
    .sort()
    .map((name) => path.join(directory, name));
}

async function startCpuProfiler(session) {
  await session.send('Profiler.enable');
  await session.send('Profiler.setSamplingInterval', {
    interval: CPU_SAMPLING_INTERVAL_US,
  });
  await session.send('Profiler.start');
}

function errorMessage(error) {
  return error && typeof error === 'object' && 'message' in error
    ? String(error.message)
    : String(error);
}

export async function stopDiagnosticTrace({
  electronApp,
  tracePath,
  timeoutMs = DIAGNOSTIC_TRACE_STOP_TIMEOUT_MS,
}) {
  let timer;
  const stopping = Promise.resolve().then(() =>
    electronApp.evaluate(async ({ contentTracing }, destination) => {
      await contentTracing.stopRecording(destination);
    }, tracePath),
  );
  // A native stop can reject after our deadline. Observe that rejection even
  // after this function has returned a bounded timeout.
  stopping.catch(() => undefined);
  try {
    return await Promise.race([
      stopping,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Electron trace stop timed out after ${timeoutMs} ms; Chromium stop is unconfirmed`,
              ),
            ),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function boundedDiagnosticOperation(label, operation, timeoutMs, errors) {
  let timer;
  const pending = Promise.resolve().then(operation);
  pending.catch(() => undefined);
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `timed out after ${timeoutMs} ms; completion is unknown`,
              ),
            ),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    errors.push(`${label}: ${errorMessage(error)}`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function stopDiagnosticComponents({
  electronApp,
  tracePath,
  traceStarted,
  mainSession,
  mainProfilerStarted,
  rendererSession,
  rendererProfilerStarted,
  traceStopTimeoutMs,
  cleanupOperationTimeoutMs,
}) {
  const errors = [];
  let traceRecorded = false;
  let mainProfile;
  let rendererProfile;

  // Start the native trace stop before waiting for any optional profiler or
  // session cleanup. Every underlying operation is invoked exactly once; a
  // timeout reports unknown completion and only stops awaiting it.
  const traceStop = traceStarted
    ? stopDiagnosticTrace({
        electronApp,
        tracePath,
        timeoutMs: traceStopTimeoutMs,
      })
        .then(() => {
          traceRecorded = true;
        })
        .catch((error) => {
          errors.push(`Electron trace: ${errorMessage(error)}`);
        })
    : Promise.resolve();
  const mainStop = (async () => {
    if (mainProfilerStarted) {
      const result = await boundedDiagnosticOperation(
        'main CPU profile',
        () => mainSession.send('Profiler.stop'),
        cleanupOperationTimeoutMs,
        errors,
      );
      mainProfile = result?.profile;
    }
    if (mainSession)
      await boundedDiagnosticOperation(
        'main inspector close',
        () => mainSession.close(),
        cleanupOperationTimeoutMs,
        errors,
      );
  })();
  const rendererStop = (async () => {
    if (rendererProfilerStarted) {
      const result = await boundedDiagnosticOperation(
        'renderer CPU profile',
        () => rendererSession.send('Profiler.stop'),
        cleanupOperationTimeoutMs,
        errors,
      );
      rendererProfile = result?.profile;
    }
    if (rendererSession)
      await boundedDiagnosticOperation(
        'renderer CDP detach',
        () => rendererSession.detach(),
        cleanupOperationTimeoutMs,
        errors,
      );
  })();
  await Promise.all([traceStop, mainStop, rendererStop]);
  return { errors, traceRecorded, mainProfile, rendererProfile };
}

export async function startDiagnosticCapture({
  electronApp,
  page,
  launch,
  scenarioName,
  benchmarkContext,
  dependencies = {},
}) {
  let mainSession;
  let rendererSession;
  const tracePath = path.join(launch.outputDir, 'electron-trace.json');
  let stopped = false;
  let traceStarted = false;
  let mainProfilerStarted = false;
  let rendererProfilerStarted = false;
  const traceStopTimeoutMs =
    dependencies.traceStopTimeoutMs ?? DIAGNOSTIC_TRACE_STOP_TIMEOUT_MS;
  const cleanupOperationTimeoutMs =
    dependencies.cleanupOperationTimeoutMs ??
    DIAGNOSTIC_CLEANUP_OPERATION_TIMEOUT_MS;

  try {
    mainSession = await (dependencies.connectInspector ?? connectInspector)(
      launch.inspectorPort,
    );
    rendererSession = dependencies.newRendererSession
      ? await dependencies.newRendererSession(page)
      : await page.context().newCDPSession(page);
    await electronApp.evaluate(async ({ contentTracing }, categories) => {
      await contentTracing.startRecording({
        included_categories: categories,
        recording_mode: 'record-until-full',
      });
    }, TRACE_CATEGORIES);
    traceStarted = true;
    const [mainStart, rendererStart] = await Promise.allSettled([
      startCpuProfiler(mainSession),
      startCpuProfiler(rendererSession),
    ]);
    mainProfilerStarted = mainStart.status === 'fulfilled';
    rendererProfilerStarted = rendererStart.status === 'fulfilled';
    if (mainStart.status === 'rejected') throw mainStart.reason;
    if (rendererStart.status === 'rejected') throw rendererStart.reason;
  } catch (error) {
    const rollback = await stopDiagnosticComponents({
      electronApp,
      tracePath,
      traceStarted,
      mainSession,
      mainProfilerStarted,
      rendererSession,
      rendererProfilerStarted,
      traceStopTimeoutMs,
      cleanupOperationTimeoutMs,
    });
    const primary =
      error instanceof Error ? error : new Error(errorMessage(error));
    primary.diagnosticCapture = {
      status: 'partial',
      samplingIntervalUs: CPU_SAMPLING_INTERVAL_US,
      traceCategories: TRACE_CATEGORIES,
      artifacts: rollback.traceRecorded ? { trace: tracePath } : {},
      summaries: [],
      errors: rollback.errors,
    };
    throw primary;
  }

  return {
    async stop() {
      if (stopped) throw new Error('Diagnostic capture was already stopped');
      stopped = true;
      const { errors, traceRecorded, mainProfile, rendererProfile } =
        await stopDiagnosticComponents({
          electronApp,
          tracePath,
          traceStarted,
          mainSession,
          mainProfilerStarted,
          rendererSession,
          rendererProfilerStarted,
          traceStopTimeoutMs,
          cleanupOperationTimeoutMs,
        });

      const artifacts = traceRecorded ? { trace: tracePath } : {};
      const summaries = [];
      if (mainProfile) {
        const profilePath = path.join(launch.outputDir, 'main.cpuprofile');
        writeFileSync(profilePath, JSON.stringify(mainProfile), 'utf8');
        artifacts.mainCpuProfile = profilePath;
        summaries.push(
          summarizeCpuProfile(mainProfile, {
            processName: 'Electron main',
            samplingIntervalUs: CPU_SAMPLING_INTERVAL_US,
          }),
        );
      }
      if (rendererProfile) {
        const profilePath = path.join(launch.outputDir, 'renderer.cpuprofile');
        writeFileSync(profilePath, JSON.stringify(rendererProfile), 'utf8');
        artifacts.rendererCpuProfile = profilePath;
        summaries.push(
          summarizeCpuProfile(rendererProfile, {
            processName: 'Canopy renderer',
            samplingIntervalUs: CPU_SAMPLING_INTERVAL_US,
          }),
        );
      }
      const utilityCpuProfiles = listUtilityCpuProfiles(
        launch.utilityCpuProfileDir,
      );
      if (utilityCpuProfiles.length > 0) {
        artifacts.utilityCpuProfiles = utilityCpuProfiles;
      }
      for (const profilePath of utilityCpuProfiles) {
        try {
          const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
          summaries.push(
            summarizeCpuProfile(profile, {
              processName: `Code Graph utility (${path.basename(profilePath)})`,
              samplingIntervalUs: CPU_SAMPLING_INTERVAL_US,
            }),
          );
        } catch (error) {
          errors.push(
            `Code Graph utility CPU profile ${path.basename(profilePath)}: ${errorMessage(error)}`,
          );
        }
      }
      const hotspotsPath = path.join(launch.outputDir, 'hotspots.json');
      writeFileSync(
        hotspotsPath,
        `${JSON.stringify({ scenario: scenarioName, summaries }, null, 2)}\n`,
        'utf8',
      );
      artifacts.hotspots = hotspotsPath;
      const reportPath = path.join(launch.outputDir, 'triage.md');
      writeFileSync(
        reportPath,
        renderHotspotMarkdown({
          scenarioName,
          summaries,
          benchmarkContext,
        }),
        'utf8',
      );
      artifacts.report = reportPath;

      return {
        status: errors.length === 0 ? 'ok' : 'partial',
        samplingIntervalUs: CPU_SAMPLING_INTERVAL_US,
        traceCategories: TRACE_CATEGORIES,
        artifacts,
        summaries,
        errors,
      };
    },
  };
}
