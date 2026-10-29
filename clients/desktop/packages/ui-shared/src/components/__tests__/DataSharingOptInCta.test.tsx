/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { DATA_SHARING_OPT_IN_FEATURES } from '@canopy/protocol';
import { DATA_SHARING_OPT_IN_SCOPES } from '../../lib/data-sharing-features';
import {
  DATA_SHARING_OPT_IN_SHEET_COPY,
  DataSharingOptInCta,
  DataSharingOptInScopeSummary,
  dataSharingOptInActionLabel,
  dataSharingOptInHeadline,
  formatDataSharingScopeList,
  type DataSharingOptInCtaProps,
  type DataSharingOptInError,
} from '../DataSharingOptInCta';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ORG = 'ORGSENTINEL';
const BRAND = 'BRANDSENTINEL';
const SAVE_ERRORS: DataSharingOptInError[] = [
  'save-failed',
  'application-failed',
  'unavailable',
];

describe('DataSharingOptInCta', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  function render(props: DataSharingOptInCtaProps): void {
    act(() => root.render(<DataSharingOptInCta {...props} />));
  }
  function byId(id: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  }

  const base = {
    feature: 'leaderboards' as const,
    organizationName: 'Acme',
    productName: 'Brand',
  };

  // The web hint only opens the desktop review, which shows the full
  // disclosure before anything is saved; the hint stays a one-line invitation.
  it('keeps the web offer to a headline, one review line, and one action', () => {
    render({
      ...base,
      state: 'offer',
      summary: {
        allowedScopes: ['metadata', 'plans'],
        skippedScopes: ['transcripts'],
      },
      action: {
        kind: 'web',
        href: 'x://review',
        fallbackHref: 'x://settings/privacy',
        onActivate: () => undefined,
      },
    });
    const hint = byId('data-sharing-opt-in-leaderboards');
    expect(hint?.textContent).toContain('Join the leaderboards.');
    expect(hint?.textContent).toContain(
      "You'll review this in the Brand desktop app first.",
    );
    expect(byId('data-sharing-opt-in-leaderboards-summary')).toBeNull();
    expect(hint?.textContent).not.toContain('Review sharing your');
    expect(hint?.textContent).not.toContain('other organizations');
    expect(byId('data-sharing-opt-in-leaderboards-fallback')).toBeNull();
    expect(hint?.querySelectorAll('a')).toHaveLength(1);
    render({ ...base, state: 'enabled' });
    expect(container.textContent).toContain(
      "Future sharing follows these settings and each organization's rules.",
    );
  });

  it('offers a busy-aware desktop save with the disclosure and dismissal', () => {
    const onEnable = jest.fn();
    const onDismiss = jest.fn();
    render({
      ...base,
      state: 'offer',
      summary: { allowedScopes: ['plans', 'metadata'] },
      action: { kind: 'desktop', onEnable, busy: false },
      onDismiss,
    });
    const root = byId('data-sharing-opt-in-leaderboards');
    expect(root?.dataset.optInState).toBe('offer');
    // Passive hints do not announce themselves on mount.
    expect(root?.getAttribute('role')).toBeNull();
    expect(root?.textContent).toContain('Join the leaderboards.');
    expect(root?.textContent).toContain(
      'Shares your work stats and plans with Acme in Brand.',
    );
    expect(root?.textContent).toContain(
      'This also covers your other organizations, now and later.',
    );
    expect(root?.textContent).toContain('Personal work stays private.');
    expect(root?.textContent).toContain('Past private work stays private.');
    expect(root?.querySelector('svg[aria-hidden] + *')).toBeNull();

    const enable = byId('data-sharing-opt-in-leaderboards-enable');
    expect(enable?.tagName).toBe('BUTTON');
    expect(enable?.textContent).toBe('Share with Acme');
    act(() => enable?.click());
    expect(onEnable).toHaveBeenCalledTimes(1);
    act(() => byId('data-sharing-opt-in-leaderboards-dismiss')?.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('disables the desktop action while saving', () => {
    const onEnable = jest.fn();
    render({
      ...base,
      state: 'offer',
      summary: { allowedScopes: ['metadata'] },
      action: { kind: 'desktop', onEnable, busy: true },
    });
    const enable = byId('data-sharing-opt-in-leaderboards-enable');
    expect(enable).toHaveProperty('disabled', true);
    expect(enable?.getAttribute('aria-busy')).toBe('true');
    act(() => enable?.click());
    expect(onEnable).not.toHaveBeenCalled();
    expect(byId('data-sharing-opt-in-leaderboards-dismiss')).toBeNull();
  });

  it.each(SAVE_ERRORS)(
    'keeps a %s error on the offer with a retry',
    (error) => {
      const onEnable = jest.fn();
      render({
        ...base,
        state: 'offer',
        summary: { allowedScopes: ['metadata'] },
        action: { kind: 'desktop', onEnable, busy: false, error },
      });
      const root = byId('data-sharing-opt-in-leaderboards');
      expect(root?.dataset.optInState).toBe('offer');
      expect(root?.getAttribute('role')).toBe('status');
      expect(root?.textContent).toMatch(/Couldn't|couldn't/);
      const retry = byId('data-sharing-opt-in-leaderboards-enable');
      expect(retry?.textContent).toBe('Try again');
      act(() => retry?.click());
      expect(onEnable).toHaveBeenCalledTimes(1);
    },
  );

  it('links web offers to the desktop review', () => {
    const onActivate = jest.fn();
    render({
      ...base,
      state: 'offer',
      summary: { allowedScopes: ['metadata', 'plans'] },
      action: {
        kind: 'web',
        href: 'brand://settings/privacy?feature=leaderboards&org=x',
        fallbackHref: 'brand://settings/privacy',
        onActivate,
      },
    });
    const enable = byId('data-sharing-opt-in-leaderboards-enable');
    expect(enable?.tagName).toBe('A');
    expect(enable?.getAttribute('href')).toBe(
      'brand://settings/privacy?feature=leaderboards&org=x',
    );
    // Web never implies the click already shares.
    expect(container.textContent).toContain(
      "You'll review this in the Brand desktop app first.",
    );
    enable?.addEventListener('click', (event) => event.preventDefault());
    act(() => enable?.click());
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('gives mobile browsers an instruction instead of an action', () => {
    render({
      ...base,
      state: 'offer',
      summary: { allowedScopes: ['metadata', 'plans'] },
      action: { kind: 'mobile' },
    });
    expect(byId('data-sharing-opt-in-leaderboards')?.textContent).toContain(
      'Join the leaderboards.',
    );
    expect(byId('data-sharing-opt-in-leaderboards-summary')).toBeNull();
    expect(byId('data-sharing-opt-in-leaderboards-enable')).toBeNull();
    expect(byId('data-sharing-opt-in-leaderboards-mobile')?.textContent).toBe(
      'Turn this on in the Brand desktop app.',
    );
  });

  it('shows awaiting-desktop with only the bare Privacy fallback', () => {
    render({
      ...base,
      state: 'awaiting-desktop',
      fallbackHref: 'brand://settings/privacy',
    });
    expect(container.textContent).toContain(
      'Continue in the Brand desktop app.',
    );
    expect(byId('data-sharing-opt-in-leaderboards-enable')).toBeNull();
    const fallback = byId('data-sharing-opt-in-leaderboards-fallback');
    expect(fallback?.textContent).toBe('Open Privacy settings');
    expect(fallback?.getAttribute('href')).toBe('brand://settings/privacy');
  });

  it('shows saved state without an action or a readiness promise', () => {
    render({ ...base, state: 'enabled' });
    const root = byId('data-sharing-opt-in-leaderboards');
    expect(root?.textContent).toContain('Sharing settings saved.');
    expect(root?.textContent).toContain(
      "Future sharing follows these settings and each organization's rules.",
    );
    expect(root?.getAttribute('role')).toBe('status');
    expect(byId('data-sharing-opt-in-leaderboards-enable')).toBeNull();
  });

  it('explains managed sharing without an action or dismissal', () => {
    render({ ...base, state: 'managed', dataTestId: 'custom' });
    expect(byId('custom')?.textContent).toBe('Acme manages this sharing.');
    expect(byId('custom-enable')).toBeNull();
    expect(byId('custom-dismiss')).toBeNull();
  });

  describe('personal audience', () => {
    const personal = {
      feature: 'shared-projects' as const,
      audience: 'personal' as const,
      productName: 'Brand',
    };

    it('offers a Just me save without organization or history lines', () => {
      const onEnable = jest.fn();
      render({
        ...personal,
        state: 'offer',
        summary: { allowedScopes: ['metadata'] },
        action: { kind: 'desktop', onEnable, busy: false },
      });
      const root = byId('data-sharing-opt-in-shared-projects');
      expect(root?.dataset.optInState).toBe('offer');
      expect(root?.dataset.optInAudience).toBe('personal');
      expect(root?.getAttribute('role')).toBeNull();
      const lines = Array.from(
        byId('data-sharing-opt-in-shared-projects-summary')?.querySelectorAll(
          'li',
        ) ?? [],
        (line) => line.textContent,
      );
      expect(lines).toEqual([
        'Saves your work stats to Brand.',
        'Only you can see them.',
      ]);
      expect(root?.textContent).toContain(
        'Share your work here to invite others.',
      );
      expect(root?.textContent).not.toContain('other organizations');
      expect(root?.textContent).not.toContain('Personal work stays private.');
      expect(root?.textContent).not.toContain('Past private work');
      const enable = byId('data-sharing-opt-in-shared-projects-enable');
      expect(enable?.textContent).toBe('Turn on project data sharing');
      act(() => enable?.click());
      expect(onEnable).toHaveBeenCalledTimes(1);
      expect(byId('data-sharing-opt-in-shared-projects-dismiss')).toBeNull();
    });

    it('keeps a save error on the personal offer with a retry', () => {
      render({
        ...personal,
        state: 'offer',
        summary: { allowedScopes: ['metadata'] },
        action: {
          kind: 'desktop',
          onEnable: () => undefined,
          busy: false,
          error: 'save-failed',
        },
      });
      expect(
        byId('data-sharing-opt-in-shared-projects')?.getAttribute('role'),
      ).toBe('status');
      expect(
        byId('data-sharing-opt-in-shared-projects-enable')?.textContent,
      ).toBe('Try again');
    });

    it('confirms the personal save without organization rules', () => {
      render({ ...personal, state: 'enabled' });
      const root = byId('data-sharing-opt-in-shared-projects');
      expect(root?.dataset.optInState).toBe('enabled');
      expect(root?.getAttribute('role')).toBe('status');
      expect(root?.textContent).toBe('Sharing settings saved.');
    });

    it('leaves the organization render unchanged', () => {
      const props: DataSharingOptInCtaProps = {
        feature: 'shared-projects',
        organizationName: 'Acme',
        productName: 'Brand',
        state: 'offer',
        summary: { allowedScopes: ['metadata'] },
        action: { kind: 'desktop', onEnable: () => undefined, busy: false },
      };
      const html = renderToStaticMarkup(<DataSharingOptInCta {...props} />);
      expect(html).not.toContain('data-opt-in-audience');
      expect(html).toContain('Share with Acme');
      expect(html).toContain('Personal work stays private.');
    });
  });

  it('escapes organization names rather than interpreting them', () => {
    const html = renderToStaticMarkup(
      <DataSharingOptInCta
        {...base}
        organizationName={'<img src=x onerror="1">'}
        state="managed"
      />,
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('DataSharingOptInScopeSummary', () => {
  it('lists scopes in canonical order with serial-comma grammar', () => {
    expect(formatDataSharingScopeList(['metadata'])).toBe('work stats');
    expect(formatDataSharingScopeList(['transcripts', 'metadata'])).toBe(
      'work stats and chats',
    );
    expect(formatDataSharingScopeList(['summaries', 'plans', 'metadata'])).toBe(
      'work stats, plans, and work recaps',
    );
  });

  it('discloses skipped scopes and consequential sharing', () => {
    const html = renderToStaticMarkup(
      <DataSharingOptInScopeSummary
        organizationName="Acme"
        productName="Brand"
        allowedScopes={['metadata']}
        skippedScopes={['plans']}
        additionalScopes={['summaries', 'transcripts']}
      />,
    );
    expect(html).toContain('Shares your work stats with Acme in Brand.');
    expect(html).toContain(
      'Your existing settings also start sharing work recaps and chats.',
    );
    expect(html).toContain('Acme doesn&#x27;t allow sharing your plans here.');
    expect(html).toContain('Personal work stays private.');
    expect(html).toContain('now and later');
  });
});

describe('opt-in copy guard', () => {
  const BANNED =
    /\b(scope|metadata|telemetry|transcripts?|sessions?|upload|sync|visibility|token)\b|Just me|—|!/i;

  function sentences(text: string): string[] {
    return text
      .split(/(?<=[.?])\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
  }
  function templateWords(sentence: string): number {
    // Each dynamic name counts as one placeholder word.
    const placeholder = sentence
      .split(ORG)
      .join('{org}')
      .split(BRAND)
      .join('{brand}');
    return placeholder.split(/\s+/).filter(Boolean).length;
  }

  function textNodes(container: HTMLElement): string[] {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const out: string[] = [];
    while (walker.nextNode()) out.push(walker.currentNode.textContent ?? '');
    return out;
  }

  function allTemplateText(): string[] {
    const texts: string[] = [];
    const action = {
      kind: 'desktop' as const,
      onEnable: (): void => undefined,
      busy: false,
    };
    for (const feature of DATA_SHARING_OPT_IN_FEATURES) {
      texts.push(dataSharingOptInHeadline(feature));
      for (const error of [null, ...SAVE_ERRORS]) {
        const container = document.createElement('div');
        container.innerHTML = renderToStaticMarkup(
          <DataSharingOptInCta
            feature={feature}
            organizationName={ORG}
            productName={BRAND}
            state="offer"
            summary={{
              allowedScopes: DATA_SHARING_OPT_IN_SCOPES[feature],
              skippedScopes: ['summaries'],
              additionalScopes: ['transcripts'],
            }}
            action={{ ...action, error }}
          />,
        );
        texts.push(...textNodes(container));
      }
    }
    const stateless: DataSharingOptInCtaProps[] = [
      {
        feature: 'statistics',
        organizationName: ORG,
        productName: BRAND,
        state: 'enabled',
      },
      {
        feature: 'statistics',
        organizationName: ORG,
        productName: BRAND,
        state: 'managed',
      },
      {
        feature: 'shared-projects',
        audience: 'personal',
        productName: BRAND,
        state: 'enabled',
      },
    ];
    for (const props of stateless) {
      const container = document.createElement('div');
      container.innerHTML = renderToStaticMarkup(
        <DataSharingOptInCta {...props} />,
      );
      texts.push(...textNodes(container));
    }
    for (const error of [null, ...SAVE_ERRORS]) {
      const container = document.createElement('div');
      container.innerHTML = renderToStaticMarkup(
        <DataSharingOptInCta
          feature="shared-projects"
          audience="personal"
          productName={BRAND}
          state="offer"
          summary={{
            allowedScopes: DATA_SHARING_OPT_IN_SCOPES['shared-projects'],
          }}
          action={{ ...action, error }}
        />,
      );
      texts.push(...textNodes(container));
    }
    const web = document.createElement('div');
    web.innerHTML = renderToStaticMarkup(
      <DataSharingOptInCta
        feature="statistics"
        organizationName={ORG}
        productName={BRAND}
        state="offer"
        summary={{ allowedScopes: DATA_SHARING_OPT_IN_SCOPES.statistics }}
        action={{
          kind: 'web',
          href: 'x://review',
          fallbackHref: 'x://settings/privacy',
          onActivate: (): void => undefined,
        }}
      />,
    );
    texts.push(...textNodes(web));
    const awaiting = document.createElement('div');
    awaiting.innerHTML = renderToStaticMarkup(
      <DataSharingOptInCta
        feature="statistics"
        organizationName={ORG}
        productName={BRAND}
        state="awaiting-desktop"
        fallbackHref="x://settings/privacy"
      />,
    );
    texts.push(...textNodes(awaiting));
    const mobile = document.createElement('div');
    mobile.innerHTML = renderToStaticMarkup(
      <DataSharingOptInCta
        feature="statistics"
        organizationName={ORG}
        productName={BRAND}
        state="offer"
        summary={{ allowedScopes: ['metadata'] }}
        action={{ kind: 'mobile' }}
      />,
    );
    texts.push(...textNodes(mobile));
    texts.push(
      DATA_SHARING_OPT_IN_SHEET_COPY.title,
      DATA_SHARING_OPT_IN_SHEET_COPY.loading,
      DATA_SHARING_OPT_IN_SHEET_COPY.alreadyShared(ORG),
      dataSharingOptInActionLabel(ORG),
    );
    return texts;
  }

  it('keeps every template sentence short and free of banned vocabulary', () => {
    for (const text of allTemplateText()) {
      for (const sentence of sentences(text)) {
        expect(sentence).not.toMatch(BANNED);
        expect(templateWords(sentence)).toBeLessThanOrEqual(12);
      }
    }
  });

  it('accepts arbitrary organization names, including banned-looking words', () => {
    const name = 'Sync, Metadata & Upload Co. — "Just me"!';
    const html = renderToStaticMarkup(
      <DataSharingOptInCta
        feature="feed-activity"
        organizationName={name}
        productName={BRAND}
        state="offer"
        summary={{ allowedScopes: ['metadata'] }}
        action={{ kind: 'desktop', onEnable: () => undefined, busy: false }}
      />,
    );
    const container = document.createElement('div');
    container.innerHTML = html;
    expect(container.textContent).toContain(`Share with ${name}`);
    expect(container.textContent).toContain(
      `Shares your work stats with ${name} in ${BRAND}.`,
    );
  });
});
