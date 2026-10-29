import type { SubagentNode } from '@canopy/agent-transcript';
import type { DisplayMessage } from '@/components/chat/types';
import type { SubagentChatTranscriptItem } from '@canopy/agent-transcript';

export const WORKFLOW_AGENT_TRANSCRIPT_TRUNCATED_NOTICE =
  'Earlier messages are not shown.';

export type WorkflowAgentTranscriptParser = (
  lines: readonly string[],
) => readonly DisplayMessage[];

function textFromMessage(message: DisplayMessage): string {
  return message.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n');
}

/** Builds the conversation bubbles for one workflow-agent chat panel. */
export function buildWorkflowAgentTranscriptItems({
  node,
  lines,
  initialPrompt,
  parse,
}: {
  readonly node: SubagentNode;
  readonly lines: readonly string[];
  readonly initialPrompt: string | undefined;
  readonly parse: WorkflowAgentTranscriptParser;
}): readonly SubagentChatTranscriptItem[] {
  const items: SubagentChatTranscriptItem[] = [];
  const prompt = initialPrompt ?? node.prompt;
  if (prompt !== undefined && prompt.trim().length > 0) {
    items.push({
      kind: 'task',
      key: `workflow-agent-task-${node.id}`,
      sender: node.workflow?.runName ?? 'Workflow',
      text: prompt,
    });
  }

  const messages = parse(lines);
  const firstMessage = messages[0];
  const firstUserDuplicatesPrompt =
    initialPrompt !== undefined &&
    firstMessage?.role === 'user' &&
    textFromMessage(firstMessage).trim() === initialPrompt.trim();
  const transcriptMessages = firstUserDuplicatesPrompt
    ? messages.slice(1)
    : messages;

  for (const displayMessage of transcriptMessages) {
    items.push({
      kind: 'blocks',
      key: `workflow-agent-${displayMessage.id}`,
      displayMessage,
      blocks: displayMessage.blocks,
    });
  }

  return items;
}
