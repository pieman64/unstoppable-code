import '@anthropic-ai/claude-agent-sdk';

declare module '@anthropic-ai/claude-agent-sdk' {
  interface Query {
    applyFlagSettings(settings: Record<string, unknown>): Promise<void>;
  }
}
