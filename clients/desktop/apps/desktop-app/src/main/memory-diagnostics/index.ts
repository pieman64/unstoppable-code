import type { WebContents } from 'electron';
import type {
  CreateMemoryReportResult,
  MemoryDiagnosticsStatus,
} from '@canopy/desktop-shared/types';
import { createMemoryDiagnosticsService } from './service';

/** An app window's own renderer, as the host resolves it. */
export interface MemoryDiagnosticsRendererTarget {
  /** Short label for file names, for example `main` or `app-advisor`. */
  readonly label: string;
  readonly webContents: WebContents;
}

export interface MemoryDiagnosticsHost {
  /** The app renderers a report snapshots, resolved by the host. */
  getAppRenderers(): readonly MemoryDiagnosticsRendererTarget[];
}

export interface MemoryDiagnosticsService {
  setEnabled(enabled: boolean): void;
  getStatus(): Promise<MemoryDiagnosticsStatus>;
  createReport(): Promise<CreateMemoryReportResult>;
  /** Absolute folder path for a report or automatic-dump id, or null. */
  resolveReportPath(reportId: string): string | null;
  dispose(): Promise<void>;
}

const emptyHost: MemoryDiagnosticsHost = {
  getAppRenderers: (): readonly MemoryDiagnosticsRendererTarget[] => [],
};

let configuredHost = emptyHost;

// Keep the singleton stable even when quit or preference code asks for it
// before the trusted window host has been configured.
const service: MemoryDiagnosticsService = createMemoryDiagnosticsService({
  getAppRenderers: (): readonly MemoryDiagnosticsRendererTarget[] =>
    configuredHost.getAppRenderers(),
});

export function configureMemoryDiagnostics(host: MemoryDiagnosticsHost): void {
  configuredHost = host;
}

export function getMemoryDiagnosticsService(): MemoryDiagnosticsService {
  return service;
}
