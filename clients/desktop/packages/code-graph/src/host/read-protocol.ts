import type {
  CodeGraphReadFailure,
  CodeGraphPathRequest,
} from '../types/code-graph-tools';
import type { ChangeImpactReport } from '../impact/change-impact';
import type { CodeGraphBaseIdentity } from '../base-graph';
import type { ReadCodeGraphSummaryProjectionResult } from '../summary-projection';
import type { ChangedSymbol } from '../impact/changed-symbols';
import type { CodeGraphFingerprintMetadata } from '../store/database';

// The requests and responses a code-graph read host exchanges with its
// launcher.

export type CodeGraphReadCall =
  | { method: 'relationship-path'; options: CodeGraphPathRequest }
  | { method: 'status' }
  | { method: 'file-summary'; target: string; repoId?: string }
  | { method: 'scripts-for-file'; target: string; repoId?: string }
  | { method: 'ipc-channel'; target: string; repoId?: string }
  | { method: 'derived-stats'; repoId?: string }
  | { method: 'communities'; repoId?: string; limit: number }
  | { method: 'flows'; repoId?: string; limit: number }
  | {
      method: 'flows-for-symbol';
      target: string;
      repoId?: string;
      limit: number;
    }
  | { method: 'hubs'; repoId?: string; limit: number }
  | {
      method:
        | 'callers'
        | 'callees'
        | 'importers'
        | 'imports'
        | 'children'
        | 'tests-for'
        | 'docs-for'
        | 'rationale-for';
      target: string;
      repoId?: string;
    }
  | { method: 'search'; query: string; limit: number }
  | { method: 'symbol-detail'; target: string; repoId?: string }
  | { method: 'community-for-symbol'; target: string; repoId?: string }
  | {
      method: 'impact-radius';
      target: string;
      options: { maxDepth?: number; maxNodes?: number };
    };

export type CodeGraphWorkerReadTask =
  | { kind: 'calls'; calls: readonly CodeGraphReadCall[] }
  | { kind: 'readonly-summary' }
  | {
      kind: 'base-identity';
      identity: CodeGraphBaseIdentity;
      gitHead: string | null;
    }
  | { kind: 'fingerprint-metadata' }
  /**
   * The one write in this lane: the end-of-build worktree fingerprint. It
   * shares the lane so worktree cleanup cancels it with the reads (same key)
   * and Electron main never opens the database read-write.
   */
  | { kind: 'persist-fingerprint'; fingerprint: string }
  /**
   * Checks a published base generation's identifying rows before shadow
   * maintenance trusts its manifest (skip as current, or seed the next build).
   */
  | {
      kind: 'validate-base';
      identity: CodeGraphBaseIdentity;
      gitHead: string | null;
    }
  | {
      kind: 'detect-changed';
      repoId: string;
      rootPath: string;
      baseRef: string;
    }
  | {
      kind: 'change-impact';
      repoId: string;
      rootPath: string;
      baseRef: string;
      resourcesDir: string;
      maxDepth?: number;
    };

export interface CodeGraphWorkerReadRequest {
  dbPath: string;
  task: CodeGraphWorkerReadTask;
}

export type CodeGraphWorkerReadResult =
  | { kind: 'calls'; value: unknown[] }
  | { kind: 'readonly-summary'; value: ReadCodeGraphSummaryProjectionResult }
  | { kind: 'base-identity'; value: CodeGraphBaseIdentityReadResult }
  | { kind: 'fingerprint-metadata'; value: CodeGraphFingerprintMetadata }
  | { kind: 'persist-fingerprint' }
  | { kind: 'validate-base'; value: boolean }
  | {
      kind: 'detect-changed';
      value: {
        changed: ChangedSymbol[];
        unmatchedFiles: string[];
        lastBuildAt: number | null;
      };
    }
  | {
      kind: 'change-impact';
      value: { report: ChangeImpactReport; lastBuildAt: number | null };
    };

/** Host utility-only identity check. No paths or raw marker text in results. */
export type CodeGraphBaseIdentityReadResult =
  | { state: 'missing' }
  | {
      state: 'readable';
      matches: {
        schema: boolean;
        extractor: boolean;
        canonicalRoot: boolean;
        customLanguagesFingerprint: boolean;
        repoId: boolean;
        gitHead: boolean;
        completed: boolean;
      };
      observed: {
        schemaVersion: number | null;
        extractorVersion: number | null;
        lastBuildAt: number | null;
        completedBuildAt: number | null;
      };
      repository: { repoId: string; gitHead: string | null } | null;
    }
  | {
      state: 'error';
      classification:
        | 'permission-denied'
        | 'busy'
        | 'corrupt'
        | 'unsupported-schema'
        | 'io';
    };

export type CodeGraphWorkerReadResponse =
  | { ok: true; result: CodeGraphWorkerReadResult }
  | { ok: false; code: CodeGraphReadFailure; message: string };
