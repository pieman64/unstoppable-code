import type {
  BrowserRectangle,
  BrowserThemeMode,
} from '@canopy/execution-engine/types/browser';
import type { FrameRegistry, NodeIdentity } from './frame-registry';

/** Computed visibility of one element, read in an isolated world. */
export interface PageModelStyleRead {
  display: string;
  visibility: string;
}

/**
 * A document-start tracker's answer for one input: never a password, was a
 * password, or unknown (an early tracker does not know this element).
 */
export type ControlHistory = 'never' | 'was' | 'unknown';

/**
 * Which tracker answers: `light` is the isolated-world tracker of a child
 * frame's light DOM, `shadow` the main-world tracker of shadow roots. Each
 * also remembers elements it saw as passwords after they move out of its
 * scope (D5).
 */
export type TrackerScope = 'light' | 'shadow';

/** Whether a tracker remembers any element that was a password. */
export type TrackerMemory = 'none' | 'some' | 'unknown';

/** All protocol responses are untrusted and decoded by the extraction stage. */
export interface PageModelDeps {
  send(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown>;
  registry: FrameRegistry;
  /**
   * The preload's main-frame password history. `scope` asks about its own
   * scope (main-frame light DOM), whose answer the host trusts for inspect
   * enrichment; `remembered` asks only whether it remembers inputs that
   * now sit elsewhere (a shadow root), and must not change that trust.
   */
  isPasswordEverSeen(
    frameId: string,
    sessionId: string,
    backendNodeIds: number[],
    purpose?: 'scope' | 'remembered',
  ): Promise<boolean[]>;
  /**
   * Reads `display` and `visibility` for elements without a layout box in one
   * frame, batched by the host. An entry is undefined when that element could
   * not be read; the whole result is undefined when the frame has no usable
   * isolated context, and the builder then falls back to the CSS domain.
   */
  readStyles?(
    frameId: string,
    sessionId: string,
    backendNodeIds: number[],
  ): Promise<Array<PageModelStyleRead | undefined> | undefined>;
  /**
   * The id of a frame's main-world (default) execution context in its
   * session, from `Runtime.executionContextCreated` (`auxData.isDefault`);
   * undefined when unknown. Needed only for frames that share a session
   * with their parent: a session's top frame is evaluated without an id.
   */
  mainWorldContextId?(frameId: string, sessionId: string): number | undefined;
  /**
   * Password history of inputs in shadow roots (any frame) or a child
   * frame's light DOM, from the document-start trackers, resolved by backend
   * node id in the tracker's own context. One entry per id; the builder
   * treats a missing dependency, undefined, a rejection, a timeout or a
   * malformed answer as unavailable. A real per-element unknown can vouch
   * outside this holder's scope; a failed whole ask cannot.
   */
  controlHistory?(
    frameId: string,
    sessionId: string,
    scope: TrackerScope,
    backendNodeIds: number[],
  ): Promise<ControlHistory[] | undefined>;
  /**
   * Whether a tracker of a frame remembers any password now; `none` lets
   * the builder skip asking it about inputs outside its scope.
   */
  controlHistorySummary?(
    frameId: string,
    sessionId: string,
    scope: TrackerScope,
  ): Promise<TrackerMemory>;
  /** One clock for timings and deadlines. */
  now(): number;
  signal?: AbortSignal;
}

export interface PageModelNode {
  identity: NodeIdentity;
  /** Frontend node ID is used only in this session, never as persistent identity. */
  nodeId: number;
  nodeType: number;
  frameRef: string;
  inShadowRoot: boolean;
  shadowRootType?: 'open' | 'closed';
  /** ID of the document or shadow root queried by DOM.querySelectorAll. */
  scopeNodeId: number;
  tagName: string;
  attributes: Record<string, string>;
  computedStyles: Record<string, string>;
  /** No layout box and the style read was skipped: treated as hidden. */
  styleUnknown?: boolean;
  hidden: boolean;
  bounds: BrowserRectangle;
  frameLocalBounds: BrowserRectangle;
  inViewport: boolean;
  value?: string;
  /**
   * The live value is unavailable (the DOM snapshot has no entry for this
   * control, e.g. an unslotted light child), so projections withhold it.
   */
  valueUnknown?: boolean;
  checked?: boolean;
  /** Snapshot selectedness for a non-secret native option. */
  selected?: boolean;
  /**
   * A non-secret native option without a value attribute: its value as
   * `HTMLOptionElement.value` gives it, cut after 241 characters.
   */
  optionValue?: string;
  /** Safe structural marker derived from a raw `role="option"` attribute. */
  isAriaOption?: true;
  /** Redaction-safe, compacted textContent. */
  text: string;
  /** Redaction-safe label text with form controls excluded when secrets exist. */
  labelText: string;
  /** Partial safe subtree text for aria-labelledby (non-secret controls retained). */
  nameText?: string;
  /** Safe direct text-node content, for model-built markup. */
  ownText: string;
  /** Full secret-safe text of one laid-out text node, for toText (not aggregate text). */
  fullText?: string;
  secret: boolean;
  insideSecretSelect: boolean;
  hasSecretDescendant: boolean;
  parentIndex?: number;
  childIndexes: number[];
  /** Stable CDP identity of an iframe's child, never inferred from src. */
  childFrameId?: string;
}

export interface PageModelFrame {
  frameId: string;
  frameRef: string;
  sessionId: string;
  loaderId: string;
  url: string;
  parentFrameId?: string;
  ownerNodeIndex?: number;
  documentNodeId: number;
  queryRootNodeIds: number[];
  depth: number;
  /**
   * Maps the frame's viewport to the top-level viewport at capture:
   * `top = (x, y) + (scaleX, scaleY) * local`.
   */
  viewportTransform: { x: number; y: number; scaleX: number; scaleY: number };
  /** The visible part of the frame in top-level viewport coordinates. */
  clip: BrowserRectangle;
}

export interface FrameCoverage {
  frameRef: string;
  /** Origin and pathname only: credentials, query and fragment are excluded. */
  url: string;
  status: 'included' | 'omitted';
  reason?: string;
}

export interface PageModelAccessibilityNode {
  frameId: string;
  backendNodeId?: number;
  role?: string;
  name?: string;
}

export interface PageModelListenerResult {
  sessionId: string;
  frameId: string;
  backendNodeIds: number[];
  /**
   * Why the frame was not scanned, or not fully: `node_limit`,
   * `main_world_unavailable`, `scan_failed`,
   * `closed_shadow_roots_not_scanned`.
   */
  skipped?: string;
}

export interface BrowserPageModel {
  nodes: PageModelNode[];
  frames: PageModelFrame[];
  coverage: FrameCoverage[];
  registry: FrameRegistry;
  capturedAt: string;
  /**
   * Builder defaults are placeholders. The host must set current browser identity,
   * URL/title, viewport/DPR, theme and runtime generation before either projection.
   */
  page: {
    browserId: string;
    runtimeGeneration?: number;
    url: string;
    title: string;
    viewport: { width: number; height: number; deviceScaleFactor: number };
    themeMode: BrowserThemeMode;
    telemetry?: {
      viewport: { width: number; height: number };
      scroll: { x: number; y: number; maxX: number; maxY: number };
    };
  };
  accessibility: PageModelAccessibilityNode[];
  listeners: PageModelListenerResult[];
  /**
   * Computed-style reads for interactive nodes without a layout box, capped
   * per build. Skipped nodes are treated as hidden.
   */
  styleSupplement: {
    candidates: number;
    read: number;
    skipped: number;
    reason?: 'cap' | 'error' | 'cap_and_error';
  };
  /**
   * Tracker queries (D6) for inputs in shadow roots and child frames that
   * are not secret by type or autocomplete: how many there were, how many
   * could leak and were asked about (capped per build), and the answers.
   * The rest of those asked about are unknown.
   */
  trackerHistory: {
    inputs: number;
    queried: number;
    never: number;
    was: number;
    /** Per-element tracker calls: one per frame, holder and batch. */
    calls: number;
    /** Summary calls ("remembers any?") to holders outside an input's scope. */
    summaries: number;
    durationMs: number;
  };
  timings: {
    extractionMs: number;
    assemblyMs: number;
    accessibilityMs: number;
    listenersMs: number;
    /** The slowest session's style supplement; part of extraction. */
    styleSupplementMs: number;
    totalMs: number;
  };
}

export interface PageModelCacheKey {
  domEventRevision: number;
  navigationSequence: number;
  actionSequence: number;
}
