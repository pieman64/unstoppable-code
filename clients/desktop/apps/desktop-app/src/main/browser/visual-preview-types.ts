/**
 * The contract between the visual preview service and its callers. It stays
 * free of Electron types so tool runtimes can import it without loading window
 * code; the service resolves lazily at the host boundary.
 */

export type VisualAppearance = 'light' | 'dark';

/** A document already prepared by the trusted preparer (images inlined). */
export interface PreparedVisual {
  readonly html: string;
  readonly unresolvedImagePaths: readonly string[];
}

export type VisualPreviewStatus =
  | 'ok'
  | 'busy'
  | 'timeout'
  | 'aborted'
  | 'error';

/** Untrusted page output: the agent document can forge any of it. */
export interface VisualDiagnostic {
  readonly level: 'log' | 'info' | 'warning' | 'error';
  readonly message: string;
  readonly line?: number;
  readonly source?: string;
}

export interface VisualCspViolation {
  readonly directive: string;
  readonly blockedUri: string;
  readonly line?: number;
  readonly source?: string;
}

export interface VisualPreviewImage {
  readonly dataUrl: string;
  readonly mime: 'image/png' | 'image/jpeg';
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

export interface VisualPreviewRequest {
  readonly prepared: PreparedVisual;
  /** CSS pixels, within {@link VISUAL_PREVIEW_LIMITS}. */
  readonly width: number;
  /** Defaults to the app's current appearance. */
  readonly appearance?: VisualAppearance;
  /** Encoded image budget in bytes; 0 means return no image. */
  readonly imageBudgetBytes: number;
  readonly signal?: AbortSignal;
}

export interface VisualPreviewResult {
  readonly status: VisualPreviewStatus;
  readonly image: VisualPreviewImage | null;
  /** Why `image` is null when the run itself succeeded. */
  readonly imageOmittedReason?: string;
  /** 0 when the run did not reach measurement. */
  readonly contentHeight: number;
  readonly capturedHeight: number;
  readonly console: readonly VisualDiagnostic[];
  readonly cspViolations: readonly VisualCspViolation[];
  /** Requests the session policy cancelled; not a complete network log. */
  readonly blockedRequests: readonly string[];
  /** Entries dropped from each list by its bound. */
  readonly omitted: {
    readonly console: number;
    readonly cspViolations: number;
    readonly blockedRequests: number;
  };
  readonly timing: {
    readonly queuedMs: number;
    readonly loadMs: number;
    readonly settleMs: number;
    readonly captureMs: number;
    readonly totalMs: number;
  };
}

export interface VisualMeasureRequest {
  readonly prepared: PreparedVisual;
  readonly appearance?: VisualAppearance;
  /** The visual's `maxHeight`; each width is measured in a frame this tall. */
  readonly maxHeight: number;
  readonly widths: readonly number[];
  /** Absolute budget, including any wait for a free slot. */
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}

export interface VisualMeasureResult {
  readonly status: VisualPreviewStatus;
  /** `[width, height]` per requested width when `status` is `ok`, else empty. */
  readonly heights: ReadonlyArray<readonly [number, number]>;
}

/** Both methods settle with a status; neither rejects. */
export interface VisualPreviewService {
  preview(request: VisualPreviewRequest): Promise<VisualPreviewResult>;
  measure(request: VisualMeasureRequest): Promise<VisualMeasureResult>;
}

export const VISUAL_PREVIEW_LIMITS = {
  maxConcurrent: 2,
  maxWaiters: 1,
  deadlineMs: 10_000,
  measureDeadlineMs: 3_000,
  minWidth: 240,
  maxWidth: 1_600,
  defaultWidth: 720,
  captureMaxHeight: 2_000,
  measureWidths: [360, 520, 720, 960],
  diagnostics: {
    console: 100,
    cspViolations: 50,
    blockedRequests: 50,
    chars: 512,
  },
} as const;

/**
 * Per-provider budgets. Codex rejects a whole dynamic tool response over
 * 64 KiB, so its budget covers the serialized response; Cursor gets no image
 * until a real run shows the model receives MCP images as images.
 */
export const VISUAL_PREVIEW_BUDGETS = {
  codexResponseBytes: 60 * 1024,
  codexTextBytes: 12 * 1024,
  claudeImageBytes: 256 * 1024,
  cursorImageBytes: 0,
} as const;
