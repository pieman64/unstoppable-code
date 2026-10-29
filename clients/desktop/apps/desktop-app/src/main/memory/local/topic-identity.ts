// One definition of "the same topic" for every local memory decision that
// compares topic names: usage rows and their lookups, auto-prune, snapshot
// restore and its cleanup, rebuild clearing, chat history profile
// preservation, and index-link resolution.
//
// macOS and Windows default to case-insensitive filesystems, where
// `topics/Build.md` and `topics/build.md` name one file. A comparison that
// keeps case can therefore record usage under a key no lookup finds, or
// delete a file it just wrote under another spelling. Identity is always
// case-folded; reads and writes keep the real on-disk filename. On a
// case-sensitive filesystem folding can only merge two names, never split
// one, so it can keep a file that might otherwise go, never lose one.

const TOPICS_PREFIX = 'topics/';

/** Identity of a `topics/` filename such as `Build.md`. */
export function topicIdentity(filename: string): string {
  return filename.toLowerCase();
}

/**
 * Identity of a scope-relative memory file key. `topics/<name>` keys fold
 * the folder and the name; every other key (inbox notes, imports, MEMORY.md)
 * is returned unchanged, since those names are generated and never
 * respelled.
 */
export function memoryFileIdentity(fileKey: string): string {
  if (
    fileKey.length > TOPICS_PREFIX.length &&
    fileKey.slice(0, TOPICS_PREFIX.length).toLowerCase() === TOPICS_PREFIX
  ) {
    return `${TOPICS_PREFIX}${topicIdentity(fileKey.slice(TOPICS_PREFIX.length))}`;
  }
  return fileKey;
}

/** The identity of a topic filename as a scope-relative file key. */
export function topicFileKeyIdentity(filename: string): string {
  return `${TOPICS_PREFIX}${topicIdentity(filename)}`;
}
