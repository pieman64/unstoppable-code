/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as sharing from '..';
import { ShareFooter } from '..';
import { ShareScopeSelector } from '@canopy/ui-shared/components';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('share components', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(element: JSX.Element): void {
    act(() => root.render(element));
  }

  it('renders scope choices and the picker for the active target scope', () => {
    const onSelect = jest.fn();
    render(
      <ShareScopeSelector
        value="team"
        onChange={onSelect}
        legend="Sharing scope"
        options={[
          { label: 'Team', value: 'team' },
          { label: 'Organization', value: 'organization' },
        ]}
        dataTestId="share-agent-scope"
      >
        <div data-testid="team-picker" />
      </ShareScopeSelector>,
    );

    expect(
      container.querySelector('[data-testid="team-picker"]'),
    ).not.toBeNull();
    act(() => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Organization')
        ?.click();
    });
    expect(onSelect).toHaveBeenCalledWith('organization');
  });

  it('keeps footer test ids consistent and exports no consent row', () => {
    const onSubmit = jest.fn();
    render(
      <ShareFooter
        onCancel={() => {}}
        showPrimary
        onSubmit={onSubmit}
        submitLabel="Share"
        testIdPrefix="share-agent"
      />,
    );

    // Pressing Share is the publication decision.
    expect(sharing).not.toHaveProperty('ShareConsent');
    expect(sharing).not.toHaveProperty('consentLabel');
    expect(sharing).not.toHaveProperty('CONSENT_PUBLIC');
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="share-agent-submit"]')
        ?.click();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('spins the primary and locks Cancel and the secondary action while loading', () => {
    render(
      <ShareFooter
        onCancel={() => {}}
        cancelTestId="share-agent-cancel"
        showPrimary
        onSubmit={() => {}}
        submitLabel="Share"
        loading
        loadingLabel="Sharing…"
        secondaryAction={{
          label: 'Manage existing access',
          onClick: () => {},
          testId: 'share-agent-manage',
        }}
        leading={<span data-testid="share-agent-leading" />}
        testIdPrefix="share-agent"
      />,
    );
    const submit = container.querySelector<HTMLButtonElement>(
      '[data-testid="share-agent-submit"]',
    );
    expect(submit?.textContent).toBe('Sharing…');
    expect(submit?.disabled).toBe(true);
    expect(submit?.getAttribute('aria-busy')).toBe('true');
    expect(
      container.querySelector('[data-testid="share-agent-submit-spinner"]'),
    ).not.toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="share-agent-cancel"]',
      )?.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="share-agent-manage"]',
      )?.disabled,
    ).toBe(true);
    expect(
      container.querySelector('[data-testid="share-agent-leading"]'),
    ).not.toBeNull();
  });
});
