import type {
  ContentBlock,
  SessionNotification,
} from '@agentclientprotocol/sdk';

type IgnoredUpdate = Exclude<
  SessionNotification['update']['sessionUpdate'],
  | 'agent_message_chunk'
  | 'agent_thought_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'usage_update'
>;
type IgnoredContent = Exclude<ContentBlock['type'], 'text'>;

export interface OpenCodeUpdateDiagnostics {
  ignoredUpdates: Partial<Record<IgnoredUpdate, number>>;
  ignoredContent: Partial<Record<IgnoredContent, number>>;
}

/** Only fixed protocol kinds and saturated counts survive; never provider data. */
export class OpenCodeUpdateAccounting {
  private readonly counts: OpenCodeUpdateDiagnostics = {
    ignoredUpdates: {},
    ignoredContent: {},
  };

  observe(update: SessionNotification['update']): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
        if (update.content.type !== 'text') {
          const type = update.content.type;
          this.counts.ignoredContent[type] = Math.min(
            1_000_000,
            (this.counts.ignoredContent[type] ?? 0) + 1,
          );
        }
        return;
      case 'tool_call':
      case 'tool_call_update':
      case 'usage_update':
        return;
      default: {
        const type = update.sessionUpdate;
        this.counts.ignoredUpdates[type] = Math.min(
          1_000_000,
          (this.counts.ignoredUpdates[type] ?? 0) + 1,
        );
      }
    }
  }

  snapshot(): OpenCodeUpdateDiagnostics | undefined {
    if (
      !Object.keys(this.counts.ignoredUpdates).length &&
      !Object.keys(this.counts.ignoredContent).length
    )
      return undefined;
    return {
      ignoredUpdates: { ...this.counts.ignoredUpdates },
      ignoredContent: { ...this.counts.ignoredContent },
    };
  }
}
