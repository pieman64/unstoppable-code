/** @jest-environment jsdom */
/**
 * Server-rendered tests for {@link ShareActionButton}: every Share action
 * draws the one share glyph, so a list row and a detail header match the
 * other share controls in the app.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { IconShareAndroid } from '../../icons/AppGlyphs.generated';
import {
  MarketplaceShareButton,
  ShareActionButton,
} from '../ShareActionButton';

function pathData(html: string): string[] {
  return Array.from(html.matchAll(/ d="([^"]+)"/g), (match) => match[1]).sort();
}

describe('ShareActionButton', () => {
  it.each(['row', 'header', 'detail'] as const)(
    'draws the share-nodes glyph in the %s placement',
    (placement) => {
      const html = renderToString(
        <ShareActionButton
          ariaLabel="Share Release notes"
          onClick={(): void => undefined}
          placement={placement}
        />,
      );

      expect(html).toContain('aria-label="Share Release notes"');
      expect(pathData(html)).toEqual(
        pathData(renderToString(<IconShareAndroid />)),
      );
    },
  );

  it('labels the detail placement with the shared secondary recipe', () => {
    const html = renderToString(
      <ShareActionButton
        ariaLabel="Share Release notes"
        onClick={(): void => undefined}
        placement="detail"
        dataTestId="share"
      />,
    );
    expect(html).toContain('>Share</button>');
    expect(html).toContain('h-7');
    // The labeled button needs no redundant `Share` tooltip wrapper.
    expect(html.startsWith('<button')).toBe(true);
  });

  it('keeps a blocked action focusable and explains it', () => {
    const html = renderToString(
      <ShareActionButton
        ariaLabel="Share Release notes"
        onClick={(): void => undefined}
        placement="detail"
        disabled
        disabledReason="This item is already public."
      />,
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('aria-description="This item is already public."');
    expect(html).not.toMatch(/\sdisabled=""/);
  });

  it('renders nothing without a host share action', () => {
    expect(
      renderToString(
        <MarketplaceShareButton
          action={undefined}
          name="Release notes"
          placement="detail"
        />,
      ),
    ).toBe('');
  });

  it('renders a blocked Marketplace action from its one state', () => {
    const html = renderToString(
      <MarketplaceShareButton
        action={{
          status: 'blocked',
          reason: 'Only the owner can share this skill.',
        }}
        name="Release notes"
        placement="detail"
      />,
    );
    expect(html).toContain('aria-label="Share Release notes"');
    expect(html).toContain('Only the owner can share this skill.');
  });
});

it('exposes the blocked reason on keyboard focus and never activates', () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onClick = jest.fn();
  try {
    act(() =>
      root.render(
        <ShareActionButton
          ariaLabel="Share Local plugin"
          placement="detail"
          disabled
          disabledReason="This plugin has no public source to share."
          onClick={onClick}
        />,
      ),
    );
    const button = container.querySelector('button');
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
      button?.focus();
    });
    expect(document.activeElement).toBe(button);
    const tooltip = document.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toContain(
      'This plugin has no public source to share.',
    );
    expect(button?.getAttribute('aria-describedby')).toBe(tooltip?.id);
    act(() => button?.click());
    expect(onClick).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
