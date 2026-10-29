import type { GitHubTokenProvider } from '@github/copilot-sdk';

/** The host-held GitHub identity a managed runtime uses; never an ambient login. */
export interface CopilotRuntimeAuth {
  /** A current access token; refreshes when under an hour remains. */
  token(signal: AbortSignal): Promise<string>;
  /** Per-session provider for `createSession` / `resumeSession`. */
  tokenProvider: GitHubTokenProvider;
}
