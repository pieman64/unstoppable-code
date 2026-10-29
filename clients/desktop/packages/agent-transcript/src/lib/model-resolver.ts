/**
 * Injectable model-resolution seam for the transcript parser.
 *
 * The parser needs to resolve model aliases, canonicalize model IDs, look up
 * display names, and read context-window sizes when it synthesizes
 * model-change markers and tracks usage. That metadata lives in
 * `@canopy/desktop-shared/types` (populated at startup from `package.json`),
 * which is a Node/desktop concern and MUST NOT be imported here — this package
 * stays browser-safe and protocol-only.
 *
 * So the desktop renderer injects the real resolver once at startup via
 * {@link setTranscriptModelResolver} (mirroring `initModelAliases`), giving it
 * full-fidelity model-change detection and context-window tracking. Any host
 * that does not configure a resolver (e.g. the hosted web run viewer, which
 * only needs the settled transcript blocks) transparently gets the identity
 * default: no alias resolution, no synthesized model-change markers, and no
 * context-window sizing — none of which the read-only viewer relies on.
 */
import type { ChatModel } from '../types';

export interface TranscriptModelResolver {
  /** Resolve a model alias to its canonical ID, or return the input unchanged. */
  resolveModelAlias(model: string): string;
  /** Return the canonical ID only when the model is registered, else undefined. */
  resolveKnownModel(model: string): ChatModel | undefined;
  /** Unwrap a custom Agent model to the provider model used at runtime. */
  resolveRuntimeModel(model: string): ChatModel | undefined;
  /** Human-readable label for a model; falls back to the raw ID. */
  getModelDisplayName(model: string): string;
  /** Configured context-window size for a model, if known. */
  getModelContextWindow(
    model: string,
    aiCreditsRouted?: boolean,
  ): number | undefined;
}

/**
 * Default resolver: no model metadata. `resolveKnownModel` returns undefined so
 * no model-change markers are synthesized, and `getModelContextWindow` returns
 * undefined so context-window tracking is a no-op.
 */
const identityResolver: TranscriptModelResolver = {
  resolveModelAlias: (model) => model,
  resolveKnownModel: () => undefined,
  resolveRuntimeModel: () => undefined,
  getModelDisplayName: (model) => model,
  getModelContextWindow: () => undefined,
};

let activeResolver: TranscriptModelResolver = identityResolver;

/** Inject the host's full-fidelity model resolver. Call once at startup. */
export function setTranscriptModelResolver(
  resolver: TranscriptModelResolver,
): void {
  activeResolver = resolver;
}

export function resolveModelAlias(model: string): string {
  return activeResolver.resolveModelAlias(model);
}

export function resolveKnownModel(model: string): ChatModel | undefined {
  return activeResolver.resolveKnownModel(model);
}

export function resolveRuntimeModel(model: string): ChatModel | undefined {
  return activeResolver.resolveRuntimeModel(model);
}

export function getModelDisplayName(model: string): string {
  return activeResolver.getModelDisplayName(model);
}

export function getModelContextWindow(
  model: string,
  aiCreditsRouted?: boolean,
): number | undefined {
  return activeResolver.getModelContextWindow(model, aiCreditsRouted);
}
