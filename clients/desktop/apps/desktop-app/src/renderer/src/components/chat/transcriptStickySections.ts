import { isHumanAuthoredUserMessage } from '@canopy/agent-transcript/transcript-storage';
import type { TurnGroup, TurnGroupOrMessage } from './types';

/**
 * One sticky section of the transcript: a run of consecutive transcript items
 * whose first item is (usually) a real user turn. While the section scrolls
 * through the viewport its head user message is rendered as a
 * `position: sticky` header, so the prompt that produced the visible agent
 * output stays readable. Scrolling up past the head hands the sticky slot to
 * the previous section's user message, exactly like the sidebar's sticky
 * workspace headers.
 *
 * Watcher-fired user messages intentionally do NOT start sections: they are
 * Canopy-generated follow-ups, so they scroll with the preceding turn's flow
 * and the previous real user message stays stuck through them.
 */
export interface TranscriptStickySection {
  /** Stable key — the head item's user/message id. */
  key: string;
  /** Index of the section's first item in the flat transcript item list. */
  startIndex: number;
  items: TurnGroupOrMessage[];
  /**
   * The head turn group whose user message is hoisted into the sticky header.
   * Absent for headerless sections: leading items before the first real user
   * turn, reverted head turns (they collapse to a bar), and standalone user
   * messages (no grouped content to scroll under them).
   */
  stickyGroup?: TurnGroup;
}

/**
 * Human prompts and trusted automatic resumes keep their own section and
 * message anchor. A resume is non-human but still starts an addressable turn:
 * queue navigation must reveal it after an offscreen reply completes.
 * Watcher turns and non-user standalone messages continue the previous section.
 */
function startsStickySection(item: TurnGroupOrMessage): boolean {
  const message = item.kind === 'turn-group' ? item.userMessage : item.message;
  return (
    isHumanAuthoredUserMessage(message) ||
    (message.role === 'user' && message.userMessageSource === 'auto_resume')
  );
}

/**
 * An agent-sent turn (a pipeline or automation send) that only leading
 * standalone messages precede, such as an automation's banner, heads its own
 * headerless section, so a link to its user message still finds the turn.
 */
function startsLeadingAgentSection(
  item: TurnGroupOrMessage,
  current: TranscriptStickySection | undefined,
): boolean {
  return (
    item.kind === 'turn-group' &&
    item.userMessage.userMessageSource === 'agent' &&
    current !== undefined &&
    current.startIndex === 0 &&
    current.items.every((entry) => entry.kind === 'standalone')
  );
}

export function computeTranscriptStickySections(
  items: readonly TurnGroupOrMessage[],
  revertedUserMessageIds: ReadonlySet<string>,
  maxItemsPerSection = Number.POSITIVE_INFINITY,
): TranscriptStickySection[] {
  const sections: TranscriptStickySection[] = [];
  const sectionItemLimit = Math.max(1, Math.floor(maxItemsPerSection));
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (
      sections.length === 0 ||
      startsStickySection(item) ||
      startsLeadingAgentSection(item, sections[sections.length - 1])
    ) {
      const stickyGroup =
        item.kind === 'turn-group' &&
        startsStickySection(item) &&
        !revertedUserMessageIds.has(item.userMessage.id)
          ? item
          : undefined;
      sections.push({
        key: item.kind === 'turn-group' ? item.userMessage.id : item.message.id,
        startIndex: index,
        items: [item],
        ...(stickyGroup ? { stickyGroup } : {}),
      });
      continue;
    }
    const currentSection = sections[sections.length - 1];
    if (currentSection.items.length >= sectionItemLimit) {
      const itemId =
        item.kind === 'turn-group' ? item.userMessage.id : item.message.id;
      sections.push({
        key: `${currentSection.key}:continuation:${itemId}`,
        startIndex: index,
        items: [item],
        ...(currentSection.stickyGroup
          ? { stickyGroup: currentSection.stickyGroup }
          : {}),
      });
      continue;
    }
    currentSection.items.push(item);
  }
  return sections;
}
