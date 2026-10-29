import { renderToString } from 'react-dom/server';
import { ModelGroupHeader } from '../ModelGroupHeader';

describe('ModelGroupHeader', () => {
  it('renders the label with the default model-picker heading treatment', () => {
    const html = renderToString(
      <ModelGroupHeader
        label="Claude"
        labelTestId="chat-model-group-label-claude"
      />,
    );
    expect(html).toContain('Claude');
    expect(html).toContain('data-testid="chat-model-group-label-claude"');
    // The default class list is the shared picker group-heading treatment.
    expect(html).toContain('flex items-center gap-2 px-2 pb-0.5 pt-1.5');
    expect(html).toContain('text-xs font-normal fg-secondary');
    expect(html).toContain('min-w-0 flex-1 truncate');
  });

  it('renders the icon slot with its test id and decorative aria-hidden', () => {
    const html = renderToString(
      <ModelGroupHeader
        label="Codex"
        icon={<svg data-testid="codex-svg" />}
        iconTestId="chat-model-group-icon-codex"
      />,
    );
    expect(html).toContain('data-testid="chat-model-group-icon-codex"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-testid="codex-svg"');
    expect(html).toContain('flex h-4 w-4 shrink-0 items-center justify-center');
  });

  it('omits the icon slot entirely when no icon is provided', () => {
    const html = renderToString(<ModelGroupHeader label="Ollama" />);
    expect(html).not.toContain('h-4 w-4');
    expect(html).toContain('Ollama');
  });

  it('keeps its heading treatment and lets a host add placement only', () => {
    const html = renderToString(
      <ModelGroupHeader label="AI Credits" className="mt-2" />,
    );
    expect(html).toContain(
      'class="flex items-center gap-2 px-2 pb-0.5 pt-1.5 text-xs font-normal fg-secondary mt-2"',
    );
  });
});
