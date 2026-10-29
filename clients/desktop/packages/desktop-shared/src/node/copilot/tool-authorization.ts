import type { SessionEvent } from '@github/copilot-sdk';
import { copilotMcpCallIdentity } from './tool-correlation';
import { copilotNativeOperations, isCopilotShellControl } from './tool-input';
import type {
  CopilotPreToolInput,
  CopilotToolDecision,
} from './session-policy';

interface Call {
  key: string;
  readOnly: boolean;
  observed: boolean;
  decision?: 'allow' | 'deny';
}

/** Per-turn integrity backstop. A hook decision belongs to exactly one SDK call. */
export class CopilotToolAuthorization {
  private readonly calls = new Map<string, Call>();
  private readonly ids = new Set<string>();
  private readonly events = new Set<string>();

  constructor(private readonly cwd: string) {}

  observe(event: SessionEvent): void {
    if (
      event.type !== 'tool.execution_start' &&
      event.type !== 'tool.execution_complete'
    )
      return;
    if (this.events.has(event.id)) return;
    if (this.events.size >= 32_768)
      throw new Error('Too many Copilot tool authorization events.');
    this.events.add(event.id);
    const id = event.data.toolCallId;
    if (event.type === 'tool.execution_start') {
      if (this.ids.has(id))
        throw new Error('Copilot reused a tool authorization identity.');
      if (this.calls.size >= 1024)
        throw new Error('Too many pending Copilot tool authorizations.');
      this.ids.add(id);
      const { toolName, arguments: args } = event.data;
      const operations = copilotNativeOperations(toolName, args, this.cwd);
      this.calls.set(id, {
        key: copilotMcpCallIdentity('', toolName, args),
        readOnly:
          !event.agentId &&
          !event.data.mcpToolName &&
          !event.data.mcpServerName &&
          !event.data.mcpConfigServerName &&
          ((operations !== undefined &&
            operations.length > 0 &&
            operations.every((operation) => !operation.mutates)) ||
            (/^(read|list)_/.test(toolName) &&
              isCopilotShellControl(toolName, args))),
        observed: false,
      });
      return;
    }
    const call = this.calls.get(id);
    this.calls.delete(id);
    if (
      !call ||
      (!call.observed && !call.readOnly) ||
      (call.observed &&
        (call.decision === undefined ||
          (call.decision === 'deny' && event.data.success)))
    ) {
      throw new Error(
        'Copilot completed a tool without authorization. The turn was stopped.',
      );
    }
  }

  async authorize(
    input: CopilotPreToolInput,
    signal: AbortSignal,
    decide: (input: CopilotPreToolInput) => Promise<CopilotToolDecision>,
  ): Promise<CopilotToolDecision> {
    const key = copilotMcpCallIdentity('', input.toolName, input.toolArgs);
    const entry = Array.from(this.calls.entries()).find(
      ([, call]) => !call.observed && call.key === key,
    );
    if (!entry || signal.aborted)
      return {
        decision: 'deny',
        message: 'Copilot tool authorization could not be matched to its call.',
      };
    const [id, call] = entry;
    call.observed = true;
    try {
      const decision = await decide(input);
      if (signal.aborted || this.calls.get(id) !== call)
        return { decision: 'deny' };
      call.decision = decision.decision;
      return decision;
    } catch (error) {
      call.decision = 'deny';
      throw error;
    }
  }
}
