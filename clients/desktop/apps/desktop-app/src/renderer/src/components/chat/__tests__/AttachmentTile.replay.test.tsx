/** @jest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  AttachmentCardTile,
  AttachmentImageTile,
  AttachmentTextPreview,
} from '../AttachmentTile';

function mount(markup: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = markup;
  return host;
}

describe('attachment tiles in session replay', () => {
  it('blocks an image thumbnail', () => {
    const host = mount(
      renderToStaticMarkup(
        <AttachmentImageTile>
          <img src="data:image/png;base64,AAAA" alt="screenshot.png" />
        </AttachmentImageTile>,
      ),
    );
    expect(
      host
        .querySelector('[data-attachment-kind="image"]')
        ?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS),
    ).toBe(true);
  });

  it('blocks a text glimpse while recording the file name', () => {
    const host = mount(
      renderToStaticMarkup(
        <AttachmentCardTile
          kind="file"
          preview={<AttachmentTextPreview text="secret file content" />}
          icon={null}
          name="notes.md"
        />,
      ),
    );
    // The innermost element holding the text is the preview itself.
    const preview = Array.from(host.querySelectorAll('span')).find(
      (span) =>
        span.textContent === 'secret file content' &&
        span.childElementCount === 0,
    );
    expect(preview?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).not.toBeNull();
    const name = Array.from(host.querySelectorAll('span')).find(
      (span) => span.textContent === 'notes.md' && span.childElementCount === 0,
    );
    expect(name?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });
});
