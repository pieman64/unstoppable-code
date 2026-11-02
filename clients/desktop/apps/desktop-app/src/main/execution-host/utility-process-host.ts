import * as path from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';
import type { PlatformExecutionProcessServices } from '@canopy/core-runtime';
import { runExecutionProbe } from '@canopy/desktop-shared/node/execution-host/owned-process-host';
import {
  type ExecutionHostLaunchRequest,
  type ExecutionHostPort,
  type ExecutionHostProcess,
  ReportedExecutionHost,
} from '@canopy/desktop-shared/node/execution-host/port';

class UtilityExecutionHost extends ReportedExecutionHost {
  constructor(private readonly child: UtilityProcess) {
    super();
    child.on('spawn', () => this.reportSpawn());
    child.on('message', (message: unknown) => this.reportMessage(message));
    child.on('exit', (code: number) => this.reportExit(code));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  postMessage(message: unknown): void {
    this.child.postMessage(message);
  }

  kill(): boolean {
    return this.child.kill();
  }
}

/**
 * The Electron in-process composition's execution host port. Hosts stay
 * utility processes, forked from the bundled entries beside the main bundle;
 * probes run over the owned-process primitive. Launch budgets are ignored:
 * Electron's pointer-compressed V8 already caps each heap at 4 GiB and a
 * utility process has no resident limit, so desktop hosts keep today's
 * limits until the daemon runs them under budget (CAN-5089).
 */
export function createUtilityProcessHostPort(
  options: {
    readonly entryDirectory?: string;
    readonly services?: () => PlatformExecutionProcessServices;
  } = {},
): ExecutionHostPort {
  const entryDirectory = options.entryDirectory ?? __dirname;
  // The primitive loads on the first probe, keeping its module graph out of
  // main's startup imports.
  let services: Promise<PlatformExecutionProcessServices> | undefined;
  const probeServices = (): Promise<PlatformExecutionProcessServices> => {
    services ??= options.services
      ? Promise.resolve(options.services())
      : import('@canopy/core-platform').then(
          ({ createExecutionProcessServices, hostPlatformOperatingSystem }) =>
            createExecutionProcessServices({
              os: hostPlatformOperatingSystem(),
            }),
        );
    return services;
  };
  return {
    launch(request: ExecutionHostLaunchRequest): ExecutionHostProcess {
      return new UtilityExecutionHost(
        utilityProcess.fork(path.join(entryDirectory, request.entry), [], {
          serviceName: request.serviceName,
          ...(request.env ? { env: { ...process.env, ...request.env } } : {}),
        }),
      );
    },
    probe: async (request) =>
      runExecutionProbe(await probeServices(), process.cwd(), request),
  };
}

let port: ExecutionHostPort | undefined;

/** The port the desktop's execution hosts launch through. */
export function getExecutionHostPort(): ExecutionHostPort {
  port ??= createUtilityProcessHostPort();
  return port;
}

/**
 * Composes another port, such as the owned-process port, before any host
 * launches; `undefined` restores the utility-process default.
 */
export function setExecutionHostPort(
  next: ExecutionHostPort | undefined,
): void {
  port = next;
}
