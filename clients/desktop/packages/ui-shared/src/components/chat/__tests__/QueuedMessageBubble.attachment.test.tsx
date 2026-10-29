import { renderToString } from 'react-dom/server';
import { QueuedMessageBubble } from '../QueuedMessageBubble';

describe('QueuedMessageBubble attachment', () => {
  it('renders an attachment above the bubble surface inside its width wrapper', () => {
    const html = renderToString(
      <QueuedMessageBubble
        message={{ id: 'queue-1', text: 'queued text' }}
        attachment={<span data-testid="queued-attachment">About Planner</span>}
      />,
    );

    expect(html).toContain('data-testid="queued-attachment"');
    expect(html).toContain('class="mb-1 flex justify-end"');
    expect(html.indexOf('queued-attachment')).toBeLessThan(
      html.indexOf('bg-fg-primary/[0.08]'),
    );
    expect(html).toContain('queued text');
  });

  it('renders no attachment row when omitted', () => {
    const html = renderToString(
      <QueuedMessageBubble message={{ id: 'queue-1', text: 'queued text' }} />,
    );

    expect(html).not.toContain('mb-1 flex justify-end');
    expect(html).toContain('queued text');
  });
});
