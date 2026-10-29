import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { createHash } from 'node:crypto';
import type {
  LocalMemoryDocument,
  LocalMemoryItem,
} from '@canopy/desktop-shared/types';

type MarkdownBlock = ReturnType<typeof fromMarkdown>['children'][number];
type MarkdownListItem = Extract<
  MarkdownBlock,
  { type: 'list' }
>['children'][number];

interface SourceItem extends LocalMemoryItem {
  start: number;
  end: number;
  children: SourceItem[];
}

function revision(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function parseItems(content: string): SourceItem[] {
  const frontmatter = /^\uFEFF?---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/.exec(
    content,
  );
  const bodyOffset = frontmatter?.[0].length ?? 0;
  const source = content.slice(bodyOffset);
  const bomOffset = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const sourceOffset = bodyOffset + bomOffset;
  const document = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const roots: SourceItem[] = [];
  const headings: SourceItem[] = [];
  let previousEnd = sourceOffset;
  const append = (
    node: MarkdownBlock | MarkdownListItem,
    kind: LocalMemoryItem['kind'],
    level?: number,
  ): void => {
    const startOffset = node.position?.start.offset;
    const endOffset = node.position?.end.offset;
    if (
      typeof startOffset !== 'number' ||
      typeof endOffset !== 'number' ||
      !Number.isInteger(startOffset) ||
      !Number.isInteger(endOffset) ||
      startOffset < 0 ||
      endOffset <= startOffset ||
      endOffset > source.length - bomOffset ||
      startOffset + sourceOffset < previousEnd
    ) {
      throw new Error(
        'This memory file could not be parsed safely. Open it in a text editor.',
      );
    }
    const start = sourceOffset + startOffset;
    const end = sourceOffset + endOffset;
    previousEnd = end;
    const item: SourceItem = {
      id: `${start}:${end}`,
      kind,
      text: content.slice(start, end),
      children: [],
      start,
      end,
      ...(level ? { level } : {}),
    };
    if (level) {
      while (
        headings.length &&
        (headings[headings.length - 1].level ?? 0) >= level
      )
        headings.pop();
    }
    (headings[headings.length - 1]?.children ?? roots).push(item);
    if (level) headings.push(item);
  };
  for (const node of document.children) {
    if (node.type === 'list') {
      for (const item of node.children) append(item, 'list-item');
    } else {
      const level = node.type === 'heading' ? node.depth : undefined;
      const kind: LocalMemoryItem['kind'] = level
        ? 'heading'
        : node.type === 'code'
          ? 'code'
          : node.type === 'paragraph'
            ? 'paragraph'
            : 'block';
      append(node, kind, level);
    }
  }
  return roots;
}

export function parseMemoryDocument(
  fileKey: string,
  content: string,
): LocalMemoryDocument {
  const publicItem = (item: SourceItem): LocalMemoryItem => ({
    id: item.id,
    kind: item.kind,
    text: item.text,
    ...(item.level ? { level: item.level } : {}),
    children: item.children.map(publicItem),
  });
  return {
    fileKey,
    revision: revision(content),
    items: parseItems(content).map(publicItem),
  };
}
