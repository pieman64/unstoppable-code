import type {
  ExternalProjectProvider,
  ExternalProjectSurface,
} from '@canopy/desktop-shared/types';

/**
 * Internal evidence model shared by the discovery adapters and the
 * normalizer. Adapters emit one {@link DiscoveredRoot} per observed folder
 * root; the normalizer canonicalizes paths, groups repository families, and
 * folds several roots into one renderer-facing candidate.
 */

export type DiscoveredSessionKind = 'claude-jsonl' | 'codex-rollout';

export interface DiscoveredSession {
  id: string;
  provider: ExternalProjectProvider;
  surface: ExternalProjectSurface;
  kind: DiscoveredSessionKind;
  /** Working directory the provider recorded for the session. */
  cwd: string;
  /** Absolute path of the transcript or rollout file. */
  sourcePath: string;
  title: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  sizeBytes: number;
  /**
   * False for sessions Canopy or another SDK host generated. Those never
   * become importable chats; they still count as evidence that the folder is
   * a project.
   */
  native: boolean;
}

export interface DiscoveredRoot {
  provider: ExternalProjectProvider;
  surface: ExternalProjectSurface;
  /** Every surface merged into this root by its adapter; `surface` is the first. */
  surfaces?: ExternalProjectSurface[];
  /** Folder path exactly as the provider recorded it (not yet canonical). */
  rootPath: string;
  /** Provider-assigned project name, when the surface has one. */
  displayName?: string;
  lastActivityAt: string | null;
  sessions: DiscoveredSession[];
}

export interface DiscoveryDiagnostic {
  source: string;
  message: string;
}

export interface AdapterResult {
  roots: DiscoveredRoot[];
  diagnostics: DiscoveryDiagnostic[];
  /** Whether the provider store exists on this machine at all. */
  detected: boolean;
}

export interface DiscoveryLimits {
  /** Provider session files inspected per adapter. */
  maxSessionFiles: number;
  /** Session files inspected per Claude project directory. */
  maxSessionFilesPerProject: number;
  /** Bytes read from the head of a session file for metadata. */
  headBytes: number;
  /** Provider desktop records inspected per record tree. */
  maxDesktopRecords: number;
  /** Explicit project keys accepted from a provider registry file. */
  maxRegistryEntries: number;
  /**
   * Largest provider registry file (`~/.claude.json`) read in full. Beyond
   * this the file is skipped with a diagnostic instead of parsing tens of
   * megabytes on the Electron main thread.
   */
  maxGlobalConfigBytes: number;
  /** Largest Claude Desktop session record read; larger records are skipped. */
  maxDesktopRecordBytes: number;
  /**
   * Stats and file reads in flight at once across one adapter's whole scan:
   * one pool is shared by every directory and every file, so the bound is
   * this number, not a product of nested pools. A scan is bound by per-call
   * latency, not bytes, so the pool shortens it by roughly this factor
   * without changing what is read.
   */
  maxConcurrentReads: number;
}

// Sized for a heavy local store: several thousand transcripts across
// hundreds of project directories. Session metadata (cwd, id, entrypoint,
// first prompt) sits in the first few KiB, so a small head per file buys
// a larger file budget for the same bytes read.
export const DEFAULT_DISCOVERY_LIMITS: DiscoveryLimits = {
  maxSessionFiles: 8000,
  maxSessionFilesPerProject: 40,
  headBytes: 16 * 1024,
  maxDesktopRecords: 1500,
  maxRegistryEntries: 5000,
  maxGlobalConfigBytes: 16 * 1024 * 1024,
  maxDesktopRecordBytes: 1024 * 1024,
  maxConcurrentReads: 16,
};
