import { renderToStaticMarkup } from 'react-dom/server';
import {
  QUEUED_MESSAGE_WAITING_REASON_COPY,
  QueuedMessageReason,
} from '../QueuedMessageReason';

describe('QueuedMessageReason', () => {
  it('renders the reason with the queued-message reason classes', () => {
    expect(
      renderToStaticMarkup(
        <QueuedMessageReason reason="Waiting for active chat sessions to finish." />,
      ),
    ).toBe(
      '<div class="mb-1 text-xs fg-secondary">Waiting for active chat sessions to finish.</div>',
    );
  });

  it('renders the copy for a host waiting reason with its test id and value', () => {
    expect(QUEUED_MESSAGE_WAITING_REASON_COPY.steer_unavailable).toBe(
      'Sends as soon as the agent can take it.',
    );
    expect(
      renderToStaticMarkup(
        <QueuedMessageReason waitingReason="steer_unavailable" />,
      ),
    ).toBe(
      '<div class="mb-1 text-xs fg-secondary" data-testid="queued-message-waiting-reason" data-waiting-reason="steer_unavailable">Sends as soon as the agent can take it.</div>',
    );
  });

  it('says a row held for background work waits for it and what Run now does', () => {
    expect(QUEUED_MESSAGE_WAITING_REASON_COPY.background_work).toBe(
      'Sends when background work finishes, so your new settings can apply. Run now sends it without them.',
    );
    expect(
      renderToStaticMarkup(
        <QueuedMessageReason waitingReason="background_work" />,
      ),
    ).toBe(
      '<div class="mb-1 text-xs fg-secondary" data-testid="queued-message-waiting-reason" data-waiting-reason="background_work">Sends when background work finishes, so your new settings can apply. Run now sends it without them.</div>',
    );
  });

  it('lets an inline reason shrink, so it truncates before the row actions', () => {
    const markup = renderToStaticMarkup(
      <QueuedMessageReason waitingReason="background_work" layout="inline" />,
    );
    const wrapper = /^<span class="([^"]*)"/.exec(markup)?.[1].split(' ');
    expect(wrapper).toContain('min-w-0');
    expect(wrapper).not.toContain('shrink-0');
  });
});
