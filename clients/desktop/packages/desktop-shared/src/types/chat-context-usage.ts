/**
 * What fills a chat's context window, by category, as the provider reports
 * it (Claude sessions today; Codex reports totals only).
 */
export interface ChatContextUsageCategory {
  /** Provider display name, e.g. "Messages" or "MCP tools (deferred)". */
  name: string;
  tokens: number;
  /**
   * `used` occupies the window; `free` is the remaining window; `buffer` is
   * the compaction reserve; `deferred` is tool schemas held out of the
   * window, listed for awareness and excluded from the usage math.
   */
  kind: 'used' | 'free' | 'buffer' | 'deferred';
}

export interface ChatContextUsageBreakdown {
  categories: ChatContextUsageCategory[];
  /** Tokens in use. */
  totalTokens: number;
  /** The window the usage is measured against. */
  maxTokens: number;
  /** Rounded share of the window in use, 0-100+. */
  percentage: number;
}

export interface ChatContextUsageRequest {
  projectId: string;
  worktreeId: string;
  chatId: string;
}
