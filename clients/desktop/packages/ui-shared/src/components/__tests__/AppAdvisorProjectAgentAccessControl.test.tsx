/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  AppAdvisorProjectAgentAccessControl,
  type AppAdvisorProjectAgentAccessControlProps,
  type AppAdvisorProjectAgentAccessOwner,
  type AppAdvisorProjectAgentAccessOwnerOption,
  type AppAdvisorProjectAgentAccessValue,
} from '../AppAdvisorProjectAgentAccessControl';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const PERSONAL_OWNER: AppAdvisorProjectAgentAccessOwner = { kind: 'personal' };
const ORG_BETA: AppAdvisorProjectAgentAccessOwner = {
  kind: 'organization',
  organizationId: 'beta-id',
};
const ORG_ALPHA: AppAdvisorProjectAgentAccessOwner = {
  kind: 'organization',
  organizationId: 'alpha-id',
};

const PERSONAL_OPTION: AppAdvisorProjectAgentAccessOwnerOption = {
  owner: PERSONAL_OWNER,
  label: 'Personal',
};

const OWNER_OPTIONS: AppAdvisorProjectAgentAccessOwnerOption[] = [
  PERSONAL_OPTION,
  { owner: ORG_BETA, label: 'Beta team' },
  { owner: ORG_ALPHA, label: 'Alpha team' },
];

const DEFAULT_VALUE: AppAdvisorProjectAgentAccessValue = {
  mode: 'enabled',
  selectedOwners: [],
};

describe('AppAdvisorProjectAgentAccessControl', () => {
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

  function renderControl(
    overrides: Partial<AppAdvisorProjectAgentAccessControlProps> = {},
  ): void {
    const props: AppAdvisorProjectAgentAccessControlProps = {
      value: DEFAULT_VALUE,
      ownerOptions: OWNER_OPTIONS,
      onChange: jest.fn(),
      ...overrides,
    };
    act(() => {
      root.render(<AppAdvisorProjectAgentAccessControl {...props} />);
    });
  }

  function button(testId: string): HTMLButtonElement {
    const element = container.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
    if (!element) throw new Error(`Missing button: ${testId}`);
    return element;
  }

  function click(testId: string): void {
    act(() => {
      button(testId).click();
    });
  }

  it('renders the enabled default with the setting label and description', () => {
    renderControl();

    expect(
      container.querySelector(
        '[data-testid="app-advisor-project-agent-access"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('#app-advisor-project-agent-access-label')
        ?.textContent,
    ).toBe(
      'Allow project agents to use App Advisor chats and create automations',
    );
    expect(container.textContent).toContain(
      'Controls whether code and cowork agents can use App Advisor tools and create automations that prompt App Advisor.',
    );
    expect(
      button('app-advisor-project-agent-access-mode-enabled').getAttribute(
        'aria-pressed',
      ),
    ).toBe('true');
    expect(
      container.querySelector(
        '[data-testid="app-advisor-project-agent-access-mode-description"]',
      )?.textContent,
    ).toBe(
      'Code and cowork agents can message, read, and watch App Advisor chats, and can create automations that prompt App Advisor.',
    );
  });

  it.each([
    [
      'enabled',
      'Code and cowork agents can message, read, and watch App Advisor chats, and can create automations that prompt App Advisor.',
    ],
    [
      'selected-owners',
      'Only agents in projects owned by the selected owners (Personal or an organization) can message, read, and watch App Advisor chats or create App Advisor automations.',
    ],
    [
      'disabled',
      "Code and cowork agents can't message, read, or watch App Advisor chats, or create automations that prompt App Advisor. Automations that already exist keep running.",
    ],
  ] as const)('describes the %s mode', (mode, description) => {
    renderControl({ value: { mode, selectedOwners: [] } });

    expect(
      container.querySelector(
        '[data-testid="app-advisor-project-agent-access-mode-description"]',
      )?.textContent,
    ).toBe(description);
  });

  it.each([
    ['enabled', 'selected-owners'],
    ['enabled', 'disabled'],
    ['disabled', 'enabled'],
  ] as const)(
    'emits the complete value when changing from %s to %s',
    (currentMode, nextMode) => {
      const selectedOwners: AppAdvisorProjectAgentAccessOwner[] = [ORG_BETA];
      let nextValue: AppAdvisorProjectAgentAccessValue | undefined;
      const onChange = (next: AppAdvisorProjectAgentAccessValue): void => {
        nextValue = next;
      };
      renderControl({
        value: { mode: currentMode, selectedOwners },
        onChange,
      });

      click(`app-advisor-project-agent-access-mode-${nextMode}`);

      expect(nextValue).toEqual({ mode: nextMode, selectedOwners });
      expect(nextValue?.selectedOwners).not.toBe(selectedOwners);
    },
  );

  it('does nothing when the active mode is selected again', () => {
    const onChange = jest.fn();
    renderControl({ onChange });

    click('app-advisor-project-agent-access-mode-enabled');

    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the owner list only in selected-owners mode', () => {
    renderControl();
    expect(
      container.querySelector(
        '[data-testid="app-advisor-project-agent-access-owner-list"]',
      ),
    ).toBeNull();

    renderControl({ value: { mode: 'selected-owners', selectedOwners: [] } });
    expect(
      container.querySelector(
        '[data-testid="app-advisor-project-agent-access-owner-list"]',
      ),
    ).not.toBeNull();
  });

  it('renders owner options in the supplied order without sorting', () => {
    renderControl({ value: { mode: 'selected-owners', selectedOwners: [] } });

    const rows = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[data-testid^="app-advisor-project-agent-access-owner-"]',
      ),
    );
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      'app-advisor-project-agent-access-owner-personal',
      'app-advisor-project-agent-access-owner-organization-beta-id',
      'app-advisor-project-agent-access-owner-organization-alpha-id',
    ]);
  });

  it('marks owner rows with the shared checkbox ChoiceMark', () => {
    renderControl({
      value: { mode: 'selected-owners', selectedOwners: [ORG_BETA] },
    });
    const mark = (testId: string): Element | null =>
      button(testId).querySelector('span[aria-hidden="true"]');
    const selected = mark(
      'app-advisor-project-agent-access-owner-organization-beta-id',
    );
    const unselected = mark('app-advisor-project-agent-access-owner-personal');
    // ChoiceMark: a rounded 16px box, filled with the page ink when checked.
    expect(selected?.className).toContain('rounded');
    expect(selected?.className).toContain('bg-fg-primary');
    expect(selected?.querySelector('svg')).not.toBeNull();
    expect(unselected?.className).toContain('ring-fg-quaternary');
    expect(unselected?.querySelector('svg')).toBeNull();
  });

  it('appends selected Personal and organization owners to the saved selection', () => {
    const onChange = jest.fn();
    renderControl({
      value: { mode: 'selected-owners', selectedOwners: [ORG_BETA] },
      onChange,
    });

    click('app-advisor-project-agent-access-owner-personal');
    expect(onChange).toHaveBeenLastCalledWith({
      mode: 'selected-owners',
      selectedOwners: [ORG_BETA, PERSONAL_OWNER],
    });

    onChange.mockClear();
    renderControl({
      value: { mode: 'selected-owners', selectedOwners: [PERSONAL_OWNER] },
      onChange,
    });
    click('app-advisor-project-agent-access-owner-organization-alpha-id');
    expect(onChange).toHaveBeenCalledWith({
      mode: 'selected-owners',
      selectedOwners: [PERSONAL_OWNER, ORG_ALPHA],
    });
  });

  it('removes a selected owner without changing the order of the others', () => {
    const onChange = jest.fn();
    renderControl({
      value: {
        mode: 'selected-owners',
        selectedOwners: [PERSONAL_OWNER, ORG_BETA, ORG_ALPHA],
      },
      onChange,
    });

    click('app-advisor-project-agent-access-owner-organization-beta-id');

    expect(onChange).toHaveBeenCalledWith({
      mode: 'selected-owners',
      selectedOwners: [PERSONAL_OWNER, ORG_ALPHA],
    });
  });

  it('renders a stale selected organization as unavailable and lets it be deselected', () => {
    const staleOwner: AppAdvisorProjectAgentAccessOwner = {
      kind: 'organization',
      organizationId: 'stale-org-id',
    };
    const onChange = jest.fn();
    renderControl({
      value: { mode: 'selected-owners', selectedOwners: [staleOwner] },
      ownerOptions: [PERSONAL_OPTION],
      onChange,
    });

    const staleRow = button(
      'app-advisor-project-agent-access-owner-organization-stale-org-id',
    );
    expect(staleRow.textContent).toContain('Unavailable organization');
    expect(staleRow.textContent).toContain('stale-org-id');
    expect(staleRow.getAttribute('data-unavailable')).toBe('true');
    expect(staleRow.getAttribute('aria-pressed')).toBe('true');
    expect(staleRow.hasAttribute('aria-disabled')).toBe(false);

    click('app-advisor-project-agent-access-owner-organization-stale-org-id');
    expect(onChange).toHaveBeenCalledWith({
      mode: 'selected-owners',
      selectedOwners: [],
    });
  });

  it('renders a selected Personal owner omitted by the host as a normal row', () => {
    renderControl({
      value: { mode: 'selected-owners', selectedOwners: [PERSONAL_OWNER] },
      ownerOptions: [],
    });

    const personalRow = button(
      'app-advisor-project-agent-access-owner-personal',
    );
    expect(personalRow.textContent).toBe('Personal');
    expect(personalRow.hasAttribute('data-unavailable')).toBe(false);
  });

  it('does not select an unavailable option that is not already selected', () => {
    const unavailableOption: AppAdvisorProjectAgentAccessOwnerOption = {
      owner: ORG_ALPHA,
      label: 'Alpha team',
      unavailable: true,
    };
    const onChange = jest.fn();
    renderControl({
      value: { mode: 'selected-owners', selectedOwners: [] },
      ownerOptions: [unavailableOption],
      onChange,
    });

    const unavailableRow = button(
      'app-advisor-project-agent-access-owner-organization-alpha-id',
    );
    expect(unavailableRow.textContent).toContain('Alpha team (unavailable)');
    expect(unavailableRow.getAttribute('data-unavailable')).toBe('true');
    expect(unavailableRow.getAttribute('aria-disabled')).toBe('true');
    click('app-advisor-project-agent-access-owner-organization-alpha-id');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the empty-selection hint', () => {
    renderControl({ value: { mode: 'selected-owners', selectedOwners: [] } });

    expect(
      container.querySelector(
        '[data-testid="app-advisor-project-agent-access-no-owners"]',
      )?.textContent,
    ).toBe('No owners selected, so no project agents can use App Advisor.');
  });

  it.each([{ disabled: true }, { saving: true }])(
    'disables segments and rows and emits nothing for $disabled/$saving',
    (state) => {
      const onChange = jest.fn();
      renderControl({
        value: { mode: 'selected-owners', selectedOwners: [] },
        onChange,
        ...state,
      });

      for (const mode of ['enabled', 'selected-owners', 'disabled']) {
        expect(
          button(`app-advisor-project-agent-access-mode-${mode}`).disabled,
        ).toBe(true);
      }
      expect(
        button('app-advisor-project-agent-access-owner-personal').disabled,
      ).toBe(true);
      click('app-advisor-project-agent-access-mode-disabled');
      click('app-advisor-project-agent-access-owner-personal');
      expect(onChange).not.toHaveBeenCalled();

      if (state.saving) {
        expect(
          container
            .querySelector('[data-testid="app-advisor-project-agent-access"]')
            ?.getAttribute('aria-busy'),
        ).toBe('true');
      }
    },
  );

  it('uses a custom test id prefix for all contracted hooks', () => {
    renderControl({
      testIdPrefix: 'custom-access',
      value: { mode: 'selected-owners', selectedOwners: [] },
    });

    expect(
      container.querySelector('[data-testid="custom-access"]'),
    ).not.toBeNull();
    expect(container.querySelector('#custom-access-label')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="custom-access-mode"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="custom-access-owner-list"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="custom-access-no-owners"]'),
    ).not.toBeNull();
  });

  it('does not mutate the supplied value when adding an owner', () => {
    const selectedOwners: AppAdvisorProjectAgentAccessOwner[] = [ORG_BETA];
    Object.freeze(selectedOwners);
    const value: AppAdvisorProjectAgentAccessControlProps['value'] = {
      mode: 'selected-owners',
      selectedOwners,
    };
    Object.freeze(value);
    const onChange = jest.fn();
    renderControl({ value, onChange });

    click('app-advisor-project-agent-access-owner-organization-alpha-id');

    expect(value.mode).toBe('selected-owners');
    expect(value.selectedOwners).toEqual([ORG_BETA]);
    expect(onChange).toHaveBeenCalledWith({
      mode: 'selected-owners',
      selectedOwners: [ORG_BETA, ORG_ALPHA],
    });
  });
});
