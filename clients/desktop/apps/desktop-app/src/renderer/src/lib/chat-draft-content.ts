import { Element as SlateElement, type Descendant } from 'slate';

/**
 * Whether a saved composer draft holds typed text or file references.
 *
 * Matches `serializeEditorValue(nodes)` producing non-blank text or any file
 * reference, without loading the React editor: chat stores read this too.
 */
export function draftHasContent(nodes: Descendant[]): boolean {
  return nodes.some(nodeHasContent);
}

function nodeHasContent(node: Descendant): boolean {
  if (!SlateElement.isElement(node)) return /\S/.test(node.text);
  if (node.type === 'file-reference') return true;
  return node.children.some(nodeHasContent);
}
