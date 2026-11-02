import { Element, type Descendant } from 'slate';

/** Meaningful rich content includes file pills even when they have no text. */
export function richDraftHasContent(nodes: readonly Descendant[]): boolean {
  return nodes.some((node) =>
    Element.isElement(node)
      ? node.type === 'file-reference' || richDraftHasContent(node.children)
      : /\S/.test(node.text),
  );
}

/** Shared append policy; preserves nodes and represents every line as a block. */
export function appendDraftText(
  draft: readonly Descendant[] | undefined,
  text: string,
): Descendant[] {
  const paragraph = (line: string): Descendant => ({
    type: 'paragraph',
    children: [{ text: line }],
  });
  const starter = text.split(/\r?\n/).map(paragraph);
  return draft && richDraftHasContent(draft)
    ? [...structuredClone([...draft]), paragraph(''), ...starter]
    : starter;
}
