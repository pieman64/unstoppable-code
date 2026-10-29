/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ShareAudienceLabel,
  shareAudienceLabelText,
} from '../ShareAudienceLabel';
import { ShareActionButton } from '../ShareActionButton';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('ShareAudienceLabel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('names the team after the audience', () => {
    expect(shareAudienceLabelText('team', 'Growth')).toBe('Team: Growth');
  });

  it('falls back to the audience alone when the team has no name', () => {
    expect(shareAudienceLabelText('team', null)).toBe('Team');
    expect(shareAudienceLabelText('team', '  ')).toBe('Team');
  });

  it('never names a target for Organization or Public', () => {
    expect(shareAudienceLabelText('organization', 'Growth')).toBe(
      'Organization',
    );
    expect(shareAudienceLabelText('public')).toBe('Public');
  });

  it('renders quiet text rather than a pill', () => {
    act(() => {
      root.render(
        <ShareAudienceLabel
          audience="team"
          teamName="Growth"
          dataTestId="row-audience"
        />,
      );
    });
    const label = container.querySelector<HTMLElement>(
      '[data-testid="row-audience"]',
    );
    expect(label?.tagName).toBe('SPAN');
    expect(label?.textContent).toBe('Team: Growth');
    expect(label?.getAttribute('data-share-audience')).toBe('team');
    // No surface, outline or radius of its own: the ink carries it.
    expect(label?.className).toContain('fg-tertiary');
    expect(label?.className).not.toMatch(/\b(bg-|ring-|rounded|border)/);
  });
});

describe('ShareActionButton', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function button(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      '[data-testid="thing-share"]',
    );
  }

  it.each(['row', 'header'] as const)(
    'renders the share glyph with a resource-specific accessible name in a %s',
    (placement) => {
      const onClick = jest.fn();
      act(() => {
        root.render(
          <ShareActionButton
            ariaLabel="Share Release notes"
            placement={placement}
            onClick={onClick}
            dataTestId="thing-share"
          />,
        );
      });
      expect(button()?.getAttribute('aria-label')).toBe('Share Release notes');
      expect(button()?.querySelectorAll('svg')).toHaveLength(1);
      // Icon-only: the visible label is the tooltip, never inline text.
      expect(button()?.textContent).toBe('');
      act(() => {
        button()?.click();
      });
      expect(onClick).toHaveBeenCalledTimes(1);
    },
  );

  it('does not fire while disabled', () => {
    const onClick = jest.fn();
    act(() => {
      root.render(
        <ShareActionButton
          ariaLabel="Share Release notes"
          placement="row"
          disabled
          onClick={onClick}
          dataTestId="thing-share"
        />,
      );
    });
    act(() => {
      button()?.click();
    });
    expect(onClick).not.toHaveBeenCalled();
  });
});
