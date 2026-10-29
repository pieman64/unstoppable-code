import {
  subagentPromptAuthoredText,
  visibleMessageParts,
} from '../hidden-message-content';
import type { SubagentNode, SubagentTree } from '../subagent-tree';
import type {
  AnySubagentChatTranscriptItem,
  SubagentChatTaskItem,
} from './types';

/** The title of the node's parent: its parent subagent, else the root chat. */
export function subagentParentTitle(
  tree: SubagentTree,
  node: SubagentNode,
): string {
  return node.parentId === null
    ? tree.root.title
    : (tree.nodes.get(node.parentId)?.title ?? tree.root.title);
}

function authoredText(item: AnySubagentChatTranscriptItem): string | undefined {
  return item.kind === 'user' || item.kind === 'follow_up'
    ? item.text.trim()
    : undefined;
}

/**
 * A run's prompt beside its transcript. A follow-up's prompt is the authored
 * message that started it, which the transcript shows once with its real
 * author; a host message folded into that queued follow-up (such as a
 * watcher notification) shows after it. Any other prompt leads the run. A
 * prompt the transcript already shows in full adds no row.
 */
export function placeRunPrompt<
  TItem extends AnySubagentChatTranscriptItem,
>(input: {
  readonly key: string;
  readonly prompt: string;
  readonly sender: string;
  readonly items: readonly TItem[];
}): (TItem | SubagentChatTaskItem)[] {
  const { key, prompt, sender, items } = input;
  const shownTexts = items.flatMap((item) => authoredText(item) ?? []);
  const unshown = visibleMessageParts(prompt).some(
    (part) => part.kind !== 'text' || !shownTexts.includes(part.text.trim()),
  );
  if (prompt.length === 0 || !unshown) return [...items];
  const authored = subagentPromptAuthoredText(prompt, shownTexts);
  const task: SubagentChatTaskItem = {
    kind: 'task',
    key,
    sender,
    text: prompt,
    ...(authored !== undefined ? { shownTexts } : {}),
  };
  const after =
    authored === undefined
      ? -1
      : items.findIndex((item) => authoredText(item) === authored.trim());
  return after < 0
    ? [task, ...items]
    : [...items.slice(0, after + 1), task, ...items.slice(after + 1)];
}
