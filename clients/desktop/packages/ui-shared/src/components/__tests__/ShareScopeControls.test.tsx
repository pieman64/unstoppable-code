/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  OrgTeamPicker,
  ShareAudienceSelector,
  type ShareAudienceSelectorProps,
  ShareScopeSelector,
  SharedTargetPicker,
  type OrgTeamPickerProps,
  type ShareTarget,
} from '../ShareScopeControls';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

/** Whether session replay blocks `element` (it or an ancestor carries the class). */
function replayBlocked(element: Element | null | undefined): boolean {
  if (!element) throw new Error('Missing element');
  return element.closest(`.${REPLAY_BLOCK_CLASS}`) !== null;
}

interface Target {
  id: string;
  name: string;
}

const AARON: Target = { id: 'user-a', name: 'Aaron Quirk' };
const GRACE: Target = { id: 'user-b', name: 'Grace Hopper' };

interface HarnessProps {
  items: Target[];
  selectedId: string | null;
  withAvatar: boolean;
  onSelect: (target: Target) => void;
}

const DEFAULTS: HarnessProps = {
  items: [AARON, GRACE],
  selectedId: null,
  withAvatar: true,
  onSelect: () => {},
};

function harness({
  items,
  selectedId,
  withAvatar,
  onSelect,
}: HarnessProps): JSX.Element {
  return (
    <SharedTargetPicker<Target>
      searchValue=""
      onSearchChange={() => {}}
      placeholder="Search teammates by name"
      loadingLabel="Loading teammates…"
      emptyLabel="No teammates."
      loading={false}
      error={null}
      disabled={false}
      items={items}
      getKey={(item) => item.id}
      isSelected={(item) => item.id === selectedId}
      onSelect={onSelect}
      renderRow={(item) => <span>{item.name}</span>}
      getAvatarLabel={
        withAvatar ? (item: Target): string => item.name : undefined
      }
      dataTestId="target-picker"
    />
  );
}

describe('SharedTargetPicker', () => {
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

  function render(overrides: Partial<HarnessProps> = {}): void {
    act(() => {
      root.render(harness({ ...DEFAULTS, ...overrides }));
    });
  }

  function rows(): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll('li button'));
  }

  /** A row's text with decorative (aria-hidden) content removed. */
  function announcedText(row: HTMLElement): string {
    const clone = row.cloneNode(true);
    if (!(clone instanceof HTMLElement)) return '';
    for (const hidden of Array.from(
      clone.querySelectorAll('[aria-hidden="true"]'),
    )) {
      hidden.remove();
    }
    return clone.textContent ?? '';
  }

  function indicatorStates(): string[] {
    return Array.from(
      container.querySelectorAll(
        '[data-testid="shared-target-picker-selection-indicator"]',
      ),
    ).map((node) => node.getAttribute('data-selected') ?? '');
  }

  it('does not dress the results list in the search input’s chrome', () => {
    // The regression: the list carried the same radius, fill, and hairline as
    // the search box directly above it, so a one-result picker read as a
    // second, oddly-populated text field rather than as a person to pick.
    render();

    const list = container.querySelector('ul');
    const search = container.querySelector('input[type="search"]');
    expect(list).not.toBeNull();
    expect(search?.className).toContain('bg-base');
    const listClass = list?.className ?? '';
    expect(listClass).not.toContain('bg-base');
    expect(listClass).not.toContain('border');
  });

  it('gives every row a selection indicator that tracks the selection', () => {
    render();
    // An unselected row still shows the empty circle: it is what makes the row
    // legible as a choice now that the list has no box of its own.
    expect(indicatorStates()).toEqual(['false', 'false']);

    render({ selectedId: GRACE.id });
    expect(indicatorStates()).toEqual(['false', 'true']);
    expect(rows().map((row) => row.getAttribute('aria-pressed'))).toEqual([
      'false',
      'true',
    ]);
  });

  it('renders the avatar as decoration, leaving the row named by its target', () => {
    render();

    const [first] = rows();
    // Callers and specs alike select rows by their target's name. Initials
    // inside the accessible name would break every one of those selectors.
    expect(announcedText(first)).toBe('Aaron Quirk');
    const avatar = first.querySelector('[aria-hidden="true"]');
    expect(avatar?.textContent).toBe('AQ');
  });

  it("blocks a person's avatar from session replay, but not the row button", () => {
    render();

    const [first] = rows();
    const avatar = first.querySelector('[aria-hidden="true"]');
    expect(avatar?.textContent).toBe('AQ');
    expect(replayBlocked(avatar)).toBe(true);
    // rrweb drops clicks inside a block: the row itself stays recorded.
    expect(replayBlocked(first)).toBe(false);
    expect(replayBlocked(container.querySelector('input'))).toBe(false);
  });

  it('omits the avatar when the caller has no label for it', () => {
    render({ withAvatar: false });

    const [first] = rows();
    expect(first.textContent).toBe('Aaron Quirk');
    // The indicator still renders, so the row stays visibly selectable.
    expect(indicatorStates()).toEqual(['false', 'false']);
  });

  it('selects the clicked target', () => {
    const onSelect = jest.fn();
    render({ onSelect });

    act(() => {
      rows()[1].click();
    });
    expect(onSelect).toHaveBeenCalledWith(GRACE);
  });

  it('gives every row a stable option test id', () => {
    render();
    expect(rows().map((row) => row.getAttribute('data-testid'))).toEqual([
      'target-picker-option-user-a',
      'target-picker-option-user-b',
    ]);
  });
});

type Scope = 'private' | 'team' | 'organization' | 'public';

describe('ShareScopeSelector', () => {
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

  function render(
    value: Scope,
    onChange: (next: Scope) => void = () => {},
    disabled = false,
  ): void {
    act(() => {
      root.render(
        <ShareScopeSelector<Scope>
          legend="Sharing scope"
          value={value}
          onChange={onChange}
          disabled={disabled}
          options={[
            { value: 'private', label: 'Private' },
            { value: 'team', label: 'Team', disabled: true },
            { value: 'organization', label: 'Organization' },
            { value: 'public', label: 'Public' },
          ]}
          dataTestId="share-thing-scope"
        >
          <p data-testid="scope-helper">Anyone with the link can view.</p>
        </ShareScopeSelector>,
      );
    });
  }

  function radios(): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll('[role="radio"]'));
  }

  it('renders a labelled radio group with one option per scope', () => {
    render('organization');
    const group = container.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute('aria-label')).toBe('Sharing scope');
    expect(container.querySelector('legend')?.textContent).toBe(
      'Sharing scope',
    );
    // Matches every other share-dialog section heading.
    expect(container.querySelector('legend')?.className).toContain(
      'font-medium fg-primary',
    );
    expect(
      container.querySelector('fieldset')?.getAttribute('data-testid'),
    ).toBe('share-thing-scope');
    expect(radios().map((radio) => radio.getAttribute('data-testid'))).toEqual([
      'share-thing-scope-private',
      'share-thing-scope-team',
      'share-thing-scope-organization',
      'share-thing-scope-public',
    ]);
    expect(radios().map((radio) => radio.getAttribute('aria-checked'))).toEqual(
      ['false', 'false', 'true', 'false'],
    );
  });

  it('disables a single option and reports enabled choices', () => {
    const onChange = jest.fn();
    render('private', onChange);
    const [, team, organization] = radios();
    expect(team.disabled).toBe(true);
    expect(organization.disabled).toBe(false);
    act(() => {
      organization.click();
    });
    expect(onChange).toHaveBeenCalledWith('organization');
  });

  it('disables every option when the selector is disabled', () => {
    render('private', () => {}, true);
    expect(radios().every((radio) => radio.disabled)).toBe(true);
  });

  it('renders helper content under the options', () => {
    render('public');
    expect(
      container.querySelector('[data-testid="scope-helper"]')?.textContent,
    ).toBe('Anyone with the link can view.');
  });
});

describe('OrgTeamPicker', () => {
  let container: HTMLDivElement;
  let root: Root;

  const TEAM: ShareTarget = {
    id: 'team-1',
    name: 'Platform',
    secondaryLabel: 'Acme Inc',
  };
  const ORG: ShareTarget = { id: 'org-1', name: 'Acme Inc' };

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

  function render(overrides: Partial<OrgTeamPickerProps> = {}): void {
    const props: OrgTeamPickerProps = {
      kind: 'team',
      items: [TEAM],
      selectedId: null,
      onSelect: () => {},
      searchValue: '',
      onSearchChange: () => {},
      loading: false,
      error: null,
      dataTestId: 'share-thing-team-picker',
      ...overrides,
    };
    act(() => {
      root.render(<OrgTeamPicker {...props} />);
    });
  }

  function searchPlaceholder(): string | null {
    return (
      container
        .querySelector('input[type="search"]')
        ?.getAttribute('placeholder') ?? null
    );
  }

  it('uses the team copy for a team picker', () => {
    render({ items: [] });
    expect(searchPlaceholder()).toBe('Search teams…');
    expect(container.textContent).toContain('No teams found.');
    render({ loading: true });
    expect(container.textContent).toContain('Loading teams…');
  });

  it('uses the organization copy for an organization picker', () => {
    render({ kind: 'organization', items: [] });
    expect(searchPlaceholder()).toBe('Search organizations…');
    expect(container.textContent).toContain('No organizations found.');
    render({ kind: 'organization', loading: true });
    expect(container.textContent).toContain('Loading organizations…');
  });

  it('honors copy overrides', () => {
    render({ items: [], copy: { empty: 'Nothing here yet.' } });
    expect(container.textContent).toContain('Nothing here yet.');
    expect(searchPlaceholder()).toBe('Search teams…');
  });

  it('renders the avatar, name, and a team’s organization', () => {
    render();
    const row = container.querySelector(
      '[data-testid="share-thing-team-picker-option-team-1"]',
    );
    expect(row).not.toBeNull();
    expect(row?.querySelector('[aria-hidden="true"]')?.textContent).toBe('PL');
    expect(row?.textContent).toContain('Platform');
    expect(row?.textContent).toContain('Acme Inc');
  });

  it('records team and organization avatars and names in session replay', () => {
    render();
    const row = container.querySelector(
      '[data-testid="share-thing-team-picker-option-team-1"]',
    );
    expect(replayBlocked(row?.querySelector('[aria-hidden="true"]'))).toBe(
      false,
    );
    expect(row?.querySelector(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();

    render({ kind: 'organization', items: [ORG] });
    expect(
      container
        .querySelector('[data-testid="share-thing-team-picker"]')
        ?.querySelector(`.${REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
  });

  it('omits the secondary label for an organization row', () => {
    render({ kind: 'organization', items: [ORG] });
    const row = container.querySelector(
      '[data-testid="share-thing-team-picker-option-org-1"]',
    );
    expect(row?.querySelectorAll('span.block')).toHaveLength(1);
  });

  it('marks and reports the selected target', () => {
    const onSelect = jest.fn();
    render({ selectedId: TEAM.id, onSelect });
    const row = container.querySelector<HTMLButtonElement>(
      '[data-testid="share-thing-team-picker-option-team-1"]',
    );
    expect(row?.getAttribute('aria-pressed')).toBe('true');
    expect(
      row
        ?.querySelector(
          '[data-testid="shared-target-picker-selection-indicator"]',
        )
        ?.getAttribute('data-selected'),
    ).toBe('true');
    act(() => {
      row?.click();
    });
    expect(onSelect).toHaveBeenCalledWith(TEAM);
  });
});

describe('ShareAudienceSelector', () => {
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

  function render(overrides: Partial<ShareAudienceSelectorProps> = {}): void {
    const props: ShareAudienceSelectorProps = {
      offered: ['team', 'organization', 'public'],
      availability: {},
      value: 'team',
      onChange: () => {},
      legend: 'Share with',
      dataTestId: 'share-thing-scope',
      ...overrides,
    };
    act(() => {
      root.render(<ShareAudienceSelector {...props} />);
    });
  }

  function options(): string[] {
    return Array.from(container.querySelectorAll('[role="radio"]')).map(
      (el) => el.getAttribute('data-testid') ?? '',
    );
  }

  it('renders only the offered audiences, in the fixed order', () => {
    render({ offered: ['public', 'organization', 'team'] });
    expect(options()).toEqual([
      'share-thing-scope-team',
      'share-thing-scope-organization',
      'share-thing-scope-public',
    ]);
    expect(
      Array.from(container.querySelectorAll('[role="radio"]')).map(
        (el) => el.textContent,
      ),
    ).toEqual(['Team', 'Organization', 'Public']);
  });

  it('never offers Private, even when a host still lists it', () => {
    render({ offered: ['private', 'team', 'public'] });
    expect(options()).toEqual([
      'share-thing-scope-team',
      'share-thing-scope-public',
    ]);
  });

  it('checks nothing while no audience is selected', () => {
    render({ value: null });
    expect(
      Array.from(container.querySelectorAll('[role="radio"]')).map((el) =>
        el.getAttribute('aria-checked'),
      ),
    ).toEqual(['false', 'false', 'false']);
  });

  it('disables, never hides, an unavailable audience', () => {
    render({ availability: { organization: false } });
    const org = container.querySelector<HTMLButtonElement>(
      '[data-testid="share-thing-scope-organization"]',
    );
    expect(org?.disabled).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="share-thing-scope-team"]',
      )?.disabled,
    ).toBe(false);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="share-thing-scope-public"]',
      )?.disabled,
    ).toBe(false);
  });

  it('hides the selector when only one offered audience is usable', () => {
    render({
      availability: { team: false, organization: false },
      value: 'public',
      descriptions: { public: 'Anyone with the link can view this.' },
      upgradeHint: 'Upgrade to share with a team.',
      hint: <p data-testid="share-thing-scope-setup-hint">Set up</p>,
    });
    expect(container.querySelector('fieldset')).toBeNull();
    expect(container.querySelector('[role="radio"]')).toBeNull();
    expect(container.querySelector('legend')).toBeNull();
    expect(
      container.querySelector('[data-testid="share-thing-scope-upgrade-hint"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="share-thing-scope-setup-hint"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="share-thing-scope-description"]')
        ?.textContent,
    ).toBe('Anyone with the link can view this.');
  });

  it('keeps a disabled audience and its explanation visible when asked', () => {
    render({
      availability: { team: false, public: false },
      value: 'organization',
      keepDisabledVisible: true,
      optionDescribedBy: { public: 'public-locked-hint' },
      hint: (
        <p id="public-locked-hint" data-testid="share-thing-scope-locked">
          Locked
        </p>
      ),
    });
    expect(options()).toEqual([
      'share-thing-scope-team',
      'share-thing-scope-organization',
      'share-thing-scope-public',
    ]);
    const publicOption = container.querySelector<HTMLButtonElement>(
      '[data-testid="share-thing-scope-public"]',
    );
    expect(publicOption?.disabled).toBe(true);
    expect(publicOption?.getAttribute('aria-describedby')).toBe(
      'public-locked-hint',
    );
    expect(
      container
        .querySelector('[data-testid="share-thing-scope-organization"]')
        ?.hasAttribute('aria-describedby'),
    ).toBe(false);
    expect(
      container.querySelector('[data-testid="share-thing-scope-locked"]'),
    ).not.toBeNull();
  });

  it('renders nothing when the only usable audience has no description', () => {
    render({
      availability: { team: false, organization: false },
      value: 'public',
    });
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when a single offered audience has no description', () => {
    render({ offered: ['public'], value: 'public' });
    expect(container.innerHTML).toBe('');
  });

  it('keeps the description, without a selector, when a single audience is offered', () => {
    // One audience is not a choice, but the author still needs to know who
    // can see the share and where it appears.
    render({
      offered: ['public'],
      value: 'public',
      descriptions: { public: 'Anyone can view this plugin.' },
      upgradeHint: 'Upgrade to share with a team.',
    });
    expect(container.querySelector('fieldset')).toBeNull();
    expect(container.querySelector('[role="radio"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="share-thing-scope-upgrade-hint"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="share-thing-scope-description"]')
        ?.textContent,
    ).toBe('Anyone can view this plugin.');
  });

  it('shows the selected audience description and the upgrade hint', () => {
    render({
      value: 'public',
      descriptions: { public: 'Anyone can view this.' },
      upgradeHint: 'Upgrade to share with a team.',
    });
    expect(container.textContent).toContain('Anyone can view this.');
    expect(
      container.querySelector('[data-testid="share-thing-scope-upgrade-hint"]')
        ?.textContent,
    ).toBe('Upgrade to share with a team.');
  });

  it('reports the chosen audience', () => {
    const onChange = jest.fn();
    render({ onChange });
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="share-thing-scope-organization"]',
        )
        ?.click();
    });
    expect(onChange).toHaveBeenCalledWith('organization');
  });
});
