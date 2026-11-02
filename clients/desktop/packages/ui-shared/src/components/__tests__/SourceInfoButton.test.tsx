/**
 * Server-rendered tests for the shared {@link SourceInfoButton}. Verifies the
 * hover/focus reveal stays intact and coarse pointers see the button at rest.
 */
import { renderToString } from 'react-dom/server';
import { SourceInfoButton } from '../SourceInfoButton';

/** Whitespace-delimited class tokens of the `<button>` carrying `testId`. */
function buttonClassTokens(html: string, testId: string): string[] {
  const tag = html.match(
    new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`),
  )?.[0];
  return tag?.match(/class="([^"]*)"/)?.[1].split(/\s+/) ?? [];
}

describe('SourceInfoButton', () => {
  it('reveals on hover and focus, and stays visible at rest on coarse pointers', () => {
    const html = renderToString(
      <SourceInfoButton
        onClick={() => {}}
        ariaLabel="Source info for build"
        dataTestId="source-info-build"
      />,
    );
    const tokens = buttonClassTokens(html, 'source-info-build');

    expect(html).toContain('aria-label="Source info for build"');
    expect(tokens).toEqual(
      expect.arrayContaining([
        'opacity-0',
        'group-hover:opacity-100',
        'focus:opacity-100',
        'pointer-coarse:opacity-100',
      ]),
    );
  });
});
