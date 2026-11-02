/**
 * Prose models wrap and allow typographic punctuation; code keeps its policy
 * (CAN-4955).
 */
import { resolveMonacoEditorOptions } from '../monaco-editor-options';

describe('resolveMonacoEditorOptions', () => {
  it.each(['markdown', 'mdx', 'plaintext', 'latex', 'bibtex'])(
    'wraps %s and does not flag ambiguous punctuation',
    (language) => {
      const options = resolveMonacoEditorOptions(language);
      expect(options.wordWrap).toBe('on');
      expect(options.unicodeHighlight).toEqual({ ambiguousCharacters: false });
      expect(options.lineNumbers).toBe('on');
    },
  );

  it.each(['typescript', 'json', 'python'])(
    'restores the code policy explicitly for %s',
    (language) => {
      const options = resolveMonacoEditorOptions(language);
      expect(options.wordWrap).toBe('off');
      expect(options.unicodeHighlight).toEqual({ ambiguousCharacters: true });
      expect(options.lineNumbers).toBe('on');
    },
  );

  it('keeps Lean wrapping off while allowing its Unicode notation', () => {
    const options = resolveMonacoEditorOptions('lean');
    expect(options.wordWrap).toBe('off');
    expect(options.unicodeHighlight).toEqual({ ambiguousCharacters: false });
    expect(options.lineNumbers).toBe('on');
  });

  it('keeps invisible-character protections at their defaults', () => {
    expect(
      resolveMonacoEditorOptions('markdown').unicodeHighlight,
    ).not.toHaveProperty('invisibleCharacters');
  });

  it('returns stable options per language kind', () => {
    expect(resolveMonacoEditorOptions('markdown')).toBe(
      resolveMonacoEditorOptions('plaintext'),
    );
    expect(resolveMonacoEditorOptions('typescript')).toBe(
      resolveMonacoEditorOptions('json'),
    );
    expect(resolveMonacoEditorOptions('lean')).toBe(
      resolveMonacoEditorOptions('lean'),
    );
    expect(resolveMonacoEditorOptions('lean')).not.toBe(
      resolveMonacoEditorOptions('markdown'),
    );
    expect(resolveMonacoEditorOptions('lean')).not.toBe(
      resolveMonacoEditorOptions('typescript'),
    );
  });
});
