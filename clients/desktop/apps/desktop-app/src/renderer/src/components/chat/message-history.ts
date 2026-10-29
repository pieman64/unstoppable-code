import { Editor, Point, Range } from 'slate';
import type { Descendant } from 'slate';
import type { ChatMessage } from '@/stores/chatStore';
import type { ChatEditor } from '@canopy/ui-rich/types';

export type HistoryBoundary = 'start' | 'end';

export interface MessageHistoryNavigationState {
  tabId: string;
  index: number;
  draft: Descendant[];
  draftInputMode: 'typed' | 'voice';
}

export function extractUserMessageHistory(
  messages: readonly ChatMessage[],
): string[] {
  const history: string[] = [];

  for (const message of messages) {
    if (message.role !== 'user' || message.hidden) {
      continue;
    }

    const textParts: string[] = [];
    for (const block of message.blocks) {
      if (block.type === 'text') {
        textParts.push(block.text);
      }
    }

    const text = textParts.join('\n\n').trim();
    if (isGeneratedUserPrompt(text)) {
      continue;
    }

    if (text.length > 0) {
      history.push(text);
    }
  }

  return history;
}

function isGeneratedUserPrompt(text: string): boolean {
  if (
    text === 'Approved' ||
    text === 'Approved. Implement the plan.' ||
    text === 'Provide status update'
  ) {
    return true;
  }

  return (
    text.startsWith('[SESSION HANDOFF]') ||
    text.startsWith('PLEASE IMPLEMENT THIS PLAN:\n') ||
    text.startsWith('Review this plan:') ||
    text.startsWith('Review this report:')
  );
}

function isEditorSelectionAtPoint(editor: ChatEditor, point: Point): boolean {
  const selection = editor.selection;
  return (
    selection !== null &&
    Range.isCollapsed(selection) &&
    Point.equals(selection.anchor, point)
  );
}

export function isEditorSelectionAtBoundary(
  editor: ChatEditor,
  boundary: HistoryBoundary,
): boolean {
  const point =
    boundary === 'start' ? Editor.start(editor, []) : Editor.end(editor, []);
  return isEditorSelectionAtPoint(editor, point);
}
