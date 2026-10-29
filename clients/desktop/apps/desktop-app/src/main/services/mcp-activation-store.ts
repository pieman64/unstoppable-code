import {
  readMcpActivationRecord,
  type McpActivationRecord,
  type McpActivationScope,
} from '@canopy/protocol/mcp-servers';
import type { ChatStateService } from './chat-state-service';

/** Uses the canonical writer; there is no activation sidecar or second writer. */
export class McpActivationStore {
  constructor(
    private readonly chats: Pick<
      ChatStateService,
      'getCompatibilityTabs' | 'compareAndSetMcpActivation'
    >,
  ) {}

  async read(
    scope: McpActivationScope,
  ): Promise<McpActivationRecord | undefined> {
    const tabs = await this.chats.getCompatibilityTabs(scope);
    return readMcpActivationRecord(
      tabs.tabs.find((tab) => tab.id === scope.chatId)?.mcpActivation,
    );
  }

  compareAndSet(
    scope: McpActivationScope,
    expected: McpActivationRecord | undefined,
    next: McpActivationRecord,
  ): Promise<boolean> {
    return this.chats.compareAndSetMcpActivation(scope, expected, next);
  }
}
