import { parse, postprocess, preprocess } from 'micromark';
import { gfm } from 'micromark-extension-gfm';
import { decodeString } from 'micromark-util-decode-string';
import { basename } from 'node:path';
import { normalizeTopicName } from './store';
import { memoryFileIdentity, topicFileKeyIdentity } from './topic-identity';

// The one parser of topic references in a memory index, shared by the
// consolidation resolver (which rewrites each reference to the topic's real
// filename) and injection usage (which records each referenced topic as
// used). Both must recognise exactly the same forms, so neither keeps its
// own pattern: plain `topics/<name>.md`, a `./` prefix, percent-encoded
// characters and separators, Markdown escapes and entities, a `?query` or
// `#fragment`, and trailing sentence punctuation outside link destinations.

function normalizeExistingTopicFilename(topic: string): string | null {
  const filename = basename(topic);
  if (
    filename !== topic ||
    filename === '.' ||
    filename === '..' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)
  ) {
    return null;
  }
  // Canonicalize the extension to lowercase: the topic store discovers files
  // with a case-sensitive `.md` filter, so `preferences.MD` would be written
  // but permanently unreachable on case-sensitive filesystems.
  return filename.toLowerCase().endsWith('.md')
    ? `${filename.slice(0, -3)}.md`
    : `${filename}.md`;
}

/**
 * A topic filename written by consolidation output or named by an index
 * reference, with a lowercase `.md`; null when it is not a valid topic name.
 */
export function normalizeOutputTopicFilename(topic: string): string | null {
  const trimmed = topic.trim().replace(/^topics\//, '');
  const filename = normalizeExistingTopicFilename(trimmed);
  if (filename === null || !trimmed.toLowerCase().endsWith('.md')) return null;
  const stem = filename.slice(0, -3);
  return normalizeTopicName(stem) === stem ? filename : null;
}

/** Literal text of a Markdown document, with source offsets per character. */
export interface MarkdownReferenceSpan {
  text: string;
  offsets: number[];
  end: number;
  destination: boolean;
}

export function markdownReferenceSpans(
  source: string,
): MarkdownReferenceSpan[] {
  const events = postprocess(
    parse({ extensions: [gfm()] })
      .document()
      .write(preprocess()(source, 'utf8', true)),
  );
  const spans: MarkdownReferenceSpan[] = [];
  let destination = false;
  for (const [event, token] of events) {
    if (
      token.type === 'resourceDestinationString' ||
      token.type === 'definitionDestinationString'
    ) {
      destination = event === 'enter';
      continue;
    }
    if (event !== 'enter') continue;
    const escaped =
      token.type === 'characterEscape' || token.type === 'characterReference';
    if (
      !escaped &&
      ![
        'data',
        'codeTextData',
        'codeFlowValue',
        'htmlFlowData',
        'htmlTextData',
      ].includes(token.type)
    )
      continue;
    const start = token.start.offset;
    const end = token.end.offset;
    const raw = source.slice(start, end);
    const text = escaped ? decodeString(raw) : raw;
    const previous = spans[spans.length - 1];
    const span =
      previous?.end === start && previous.destination === destination
        ? previous
        : { text: '', offsets: [start], end: start, destination };
    if (span !== previous) spans.push(span);
    span.text += text;
    // Decoded escapes span several source characters; keep replacements on original token boundaries.
    for (let index = 1; index <= text.length; index += 1)
      span.offsets.push(
        escaped ? (index === text.length ? end : start) : start + index,
      );
    span.end = end;
  }
  return spans;
}

const TOPIC_REFERENCE_CANDIDATE =
  /(?<![A-Za-z0-9._/%-])(?:(?:\.{1,2}(?:\/|%2f))+)?topics(?:\/|%2f)[^\s`<>()\[\]{}"']+/gi;

/** One topic reference found in a Markdown index. */
export interface TopicReference {
  span: MarkdownReferenceSpan;
  /** Where the reference starts in `span.text`. */
  index: number;
  /** The reference as written, without its query, fragment, or punctuation. */
  encodedPath: string;
  /**
   * The topic filename it names, normalized; null when the reference does
   * not name a valid topic directly under `topics/` (for example
   * `../topics/x.md`, a nested path, or an invalid name).
   */
  filename: string | null;
}

/** Every topic reference candidate in `source`, resolvable or not. */
export function findTopicReferences(source: string): TopicReference[] {
  const references: TopicReference[] = [];
  for (const span of markdownReferenceSpans(source)) {
    for (const match of Array.from(
      span.text.matchAll(TOPIC_REFERENCE_CANDIDATE),
    )) {
      const reference = match[0];
      const trailingPunctuation = span.destination
        ? ''
        : (reference.match(/[.,;:!?]+$/)?.[0] ?? '');
      const target = reference.slice(
        0,
        reference.length - trailingPunctuation.length,
      );
      const suffixIndex = target.search(/[?#]/);
      const encodedPath =
        suffixIndex === -1 ? target : target.slice(0, suffixIndex);
      let path: string;
      try {
        path = decodeURIComponent(encodedPath).replace(/^\.\//, '');
      } catch {
        path = '';
      }
      const normalized = normalizeOutputTopicFilename(
        path.toLowerCase().startsWith('topics/')
          ? path.slice('topics/'.length)
          : '',
      );
      references.push({
        span,
        index: match.index,
        encodedPath,
        filename:
          normalized !== null &&
          memoryFileIdentity(path) === topicFileKeyIdentity(normalized)
            ? normalized
            : null,
      });
    }
  }
  return references;
}

/**
 * Topic files an index excerpt points at, as topic file key identities: a
 * link's spelling need not match the file on disk (on macOS and Windows
 * `topics/build.md` opens `Build.md`), and usage is keyed by identity so the
 * use lands on the real topic.
 */
export function referencedTopicFileKeys(source: string): string[] {
  const keys = new Set<string>();
  for (const reference of findTopicReferences(source)) {
    if (reference.filename !== null) {
      keys.add(topicFileKeyIdentity(reference.filename));
    }
  }
  return Array.from(keys);
}
