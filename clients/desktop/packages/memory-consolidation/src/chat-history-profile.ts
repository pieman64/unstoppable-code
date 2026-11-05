import { topicFileKeyIdentity } from './topic-identity';

// The generated user profile topic (CAN-3079) and the MEMORY.md line that
// links it. A scan of the user's chat titles replaces both on every refresh,
// so consolidation must keep them exactly as they are.

export const CHAT_HISTORY_PROFILE_FILE_KEY = 'topics/chat-history-profile.md';

/** Whether a `topics/` filename is the generated profile, in any casing. */
export function isChatHistoryProfileTopic(filename: string): boolean {
  return topicFileKeyIdentity(filename) === CHAT_HISTORY_PROFILE_FILE_KEY;
}

const PROFILE_REFERENCE = new RegExp(
  `(?<![A-Za-z0-9._-])${CHAT_HISTORY_PROFILE_FILE_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9._-])`,
  'i',
);

/**
 * Replaces every MEMORY.md line that references the profile with one fresh
 * line placed first (right under a leading `# ` heading), so a refresh never
 * duplicates the entry and the entry survives index clipping.
 */
export function upsertChatHistoryProfileIndexLine(
  memoryMd: string,
  line: string,
): string {
  const kept: string[] = [];
  let afterRemoval = false;
  for (const current of memoryMd.replace(/\r\n?/g, '\n').split('\n')) {
    if (PROFILE_REFERENCE.test(current)) {
      afterRemoval = true;
      continue;
    }
    const blank = current.trim() === '';
    // Collapse the blank lines a removed line leaves behind.
    if (afterRemoval && blank && kept[kept.length - 1]?.trim() === '') {
      continue;
    }
    afterRemoval = false;
    kept.push(current);
  }
  const firstContent = kept.findIndex((current) => current.trim() !== '');
  const headingEnd =
    firstContent >= 0 && /^#\s/.test(kept[firstContent] ?? '')
      ? firstContent + 1
      : 0;
  const head = kept.slice(0, headingEnd);
  const rest = kept.slice(headingEnd);
  while (rest.length > 0 && rest[0]?.trim() === '') rest.shift();
  while (rest.length > 0 && rest[rest.length - 1]?.trim() === '') rest.pop();
  const lines = [
    ...head,
    ...(head.length > 0 ? [''] : []),
    line,
    ...(rest.length > 0 ? ['', ...rest] : []),
  ];
  return `${lines.join('\n')}\n`;
}

/** The MEMORY.md line that links the profile, when the index has one. */
export function findChatHistoryProfileIndexLine(
  memoryMd: string,
): string | undefined {
  return memoryMd
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .find((line) => PROFILE_REFERENCE.test(line));
}

/**
 * Drops every index line that references the profile, changing nothing
 * else: every other line keeps its exact bytes. Null when nothing but blank
 * lines is left, since that index would link nothing.
 */
export function removeChatHistoryProfileIndexLines(
  memoryMd: string,
): string | null {
  const kept = memoryMd
    .split('\n')
    .filter((current) => !PROFILE_REFERENCE.test(current))
    .join('\n');
  return kept.trim() === '' ? null : kept;
}

/**
 * Puts `line` in place of the index's profile line, changing nothing else:
 * spacing, line endings, and every other line keep their exact bytes. An
 * index without a profile line gets it after its leading heading, or first.
 */
export function replaceChatHistoryProfileIndexLine(
  memoryMd: string,
  line: string,
): string {
  const lines = memoryMd.split('\n');
  const lineEnd = (current: string): string =>
    current.endsWith('\r') ? '\r' : '';
  const existing = lines.findIndex((current) =>
    PROFILE_REFERENCE.test(current),
  );
  if (existing >= 0) {
    return lines
      .flatMap((current, index) => {
        if (index === existing) return [`${line}${lineEnd(current)}`];
        return index > existing && PROFILE_REFERENCE.test(current)
          ? []
          : [current];
      })
      .join('\n');
  }
  const eol = memoryMd.includes('\r\n') ? '\r' : '';
  const firstContent = lines.findIndex((current) => current.trim() !== '');
  if (firstContent >= 0 && /^#\s/.test(lines[firstContent] ?? '')) {
    lines.splice(firstContent + 1, 0, eol, `${line}${eol}`);
    return lines.join('\n');
  }
  return memoryMd === ''
    ? `${line}\n`
    : [`${line}${eol}`, eol, ...lines].join('\n');
}

/**
 * Keeps a consolidation run from editing the profile, which the next scan
 * would replace wholesale (dropping whatever consolidation merged into it):
 * any rewrite of the profile topic is discarded, and the profile line the
 * index had before the run is put back as it was.
 */
export function keepChatHistoryProfile(
  previousMemoryMd: string,
  output: {
    memoryMd: string;
    topicFiles?: Array<{ filename: string; content: string }>;
  },
): {
  memoryMd: string;
  topicFiles?: Array<{ filename: string; content: string }>;
} {
  const topicFiles = output.topicFiles?.filter(
    (topic) => !isChatHistoryProfileTopic(topic.filename),
  );
  const profileLine = findChatHistoryProfileIndexLine(previousMemoryMd);
  return {
    memoryMd: profileLine
      ? upsertChatHistoryProfileIndexLine(output.memoryMd, profileLine)
      : output.memoryMd,
    ...(topicFiles ? { topicFiles } : {}),
  };
}
