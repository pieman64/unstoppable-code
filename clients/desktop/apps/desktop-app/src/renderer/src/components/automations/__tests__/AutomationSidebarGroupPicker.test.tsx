/**
 * @jest-environment jsdom
 *
 * Covers the desktop host adapter for the shared creatable group picker.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  SidebarItemGroup,
  SidebarItemGroupScope,
} from '@canopy/protocol/sidebar';
import { useSidebarItemGroupsStore } from '@/stores/sidebarItemGroupsStore';
import { AutomationSidebarGroupPicker } from '../AutomationSidebarGroupPicker';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const appAdvisorScope: SidebarItemGroupScope = { appAdvisor: true };
const workspaceScope: SidebarItemGroupScope = {
  workspaceLocalId: 'workspace-1',
};
const coworkScope: SidebarItemGroupScope = { workspaceLocalId: 'cowork-1' };

function group(
  id: string,
  name: string,
  color: SidebarItemGroup['color'],
): SidebarItemGroup {
  return { id, name, color, collapsed: false, memberIds: [] };
}

const advisorGroup = group('grp-advisor', 'Advisor', 'categorical-1');
const workspaceGroup: SidebarItemGroup = {
  ...group('grp-workspace', 'Team Review', 'categorical-2'),
  labelHidden: true,
};
const coworkGroup = group('grp-cowork', 'Notes', 'categorical-3');

let container: HTMLDivElement;
let root: Root;
let changedListener: ((scope: SidebarItemGroupScope) => void) | undefined;

const listGroups = jest.fn<
  Promise<SidebarItemGroup[]>,
  [SidebarItemGroupScope]
>();
const onChanged = jest.fn(
  (listener: (scope: SidebarItemGroupScope) => void): (() => void) => {
    changedListener = listener;
    return (): void => {
      changedListener = undefined;
    };
  },
);

beforeEach(() => {
  jest.clearAllMocks();
  changedListener = undefined;
  listGroups.mockImplementation((scope) => {
    const groups = scope.appAdvisor
      ? [advisorGroup]
      : scope.workspaceLocalId === workspaceScope.workspaceLocalId
        ? [workspaceGroup]
        : [coworkGroup];
    return Promise.resolve(groups);
  });
  useSidebarItemGroupsStore.setState({ byScope: {}, errors: {} });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { sidebarItemGroups: { list: listGroups, onChanged } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

function renderPicker(
  props: Partial<Parameters<typeof AutomationSidebarGroupPicker>[0]> = {},
): void {
  act(() => {
    root.render(
      <AutomationSidebarGroupPicker
        scope={workspaceScope}
        value=""
        onChange={jest.fn()}
        {...props}
      />,
    );
  });
}

function byTestId(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function trigger(): HTMLButtonElement {
  const element = byTestId('automations-form-sidebar-group');
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error('missing sidebar group picker trigger');
  }
  return element;
}

function option(testId: string): HTMLButtonElement {
  const element = byTestId(testId);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`missing sidebar group picker option ${testId}`);
  }
  return element;
}

function searchInput(): HTMLInputElement {
  const element = byTestId('automations-form-sidebar-group-search');
  if (!(element instanceof HTMLInputElement)) {
    throw new Error('missing sidebar group picker search input');
  }
  return element;
}

function openPicker(): void {
  act(() => trigger().click());
}

function typeSearch(text: string): void {
  const input = searchInput();
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set?.bind(input);
  if (!setValue) throw new Error('missing input value setter');
  act(() => {
    setValue(text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function pressSearchKey(key: string): void {
  act(() => {
    searchInput().dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true }),
    );
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function optionLabels(): string[] {
  openPicker();
  const labels = Array.from(document.querySelectorAll('[role="option"]')).map(
    (node) => node.textContent ?? '',
  );
  act(() => trigger().click());
  return labels;
}

describe('AutomationSidebarGroupPicker', () => {
  it('hydrates the store for its scope', async () => {
    renderPicker({ scope: appAdvisorScope });
    await settle();

    expect(listGroups).toHaveBeenCalledWith(appAdvisorScope);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('passes an existing group’s stored name when selected', async () => {
    const onChange = jest.fn();
    renderPicker({ value: '', onChange });
    await settle();
    openPicker();
    expect(
      option('automations-form-sidebar-group-option-0').textContent,
    ).toContain('Team Review');

    act(() => option('automations-form-sidebar-group-option-0').click());

    expect(onChange).toHaveBeenCalledWith('Team Review');
  });

  it('normalizes and clamps a created name to 80 characters', async () => {
    const onChange = jest.fn();
    renderPicker({ onChange });
    await settle();
    openPicker();
    const typedName = `  ${'N'.repeat(85)}  `;
    const normalizedName = 'N'.repeat(80);
    typeSearch(typedName);

    expect(
      option('automations-form-sidebar-group-option-create').textContent,
    ).toContain(`Create “${normalizedName}”`);
    pressSearchKey('Enter');

    expect(onChange).toHaveBeenCalledWith(normalizedName);
  });

  it('counts the 80-character limit in code points, not UTF-16 units', async () => {
    const onChange = jest.fn();
    renderPicker({ onChange });
    await settle();
    openPicker();
    typeSearch('😀'.repeat(85));
    pressSearchKey('Enter');

    expect(onChange).toHaveBeenCalledWith('😀'.repeat(80));
  });

  it('lists same-named groups once, as the group a run would join', async () => {
    listGroups.mockResolvedValue([
      workspaceGroup,
      group('grp-duplicate', 'team   review', 'categorical-4'),
      group('grp-other', 'Docs', 'categorical-5'),
    ]);
    renderPicker();
    await settle();

    const labels = optionLabels();
    expect(labels.filter((label) => /team\s+review/i.test(label))).toEqual([
      expect.stringContaining('Team Review'),
    ]);
    expect(labels.some((label) => label.includes('Docs'))).toBe(true);
  });

  it('selects a case-insensitive match without offering a create row', async () => {
    const onChange = jest.fn();
    renderPicker({ onChange });
    await settle();
    openPicker();
    typeSearch('  tEAm rEviEw  ');

    expect(byTestId('automations-form-sidebar-group-option-create')).toBeNull();
    pressSearchKey('Enter');

    expect(onChange).toHaveBeenCalledWith('Team Review');
  });

  it('uses the empty choice for No group', async () => {
    const onChange = jest.fn();
    renderPicker({ value: 'Team Review', onChange });
    await settle();
    openPicker();
    act(() => option('automations-form-sidebar-group-option-empty').click());

    expect(onChange).toHaveBeenCalledWith('');
  });

  it('shows a saved unmatched value with the New group hint', async () => {
    renderPicker({ value: 'Future group' });
    await settle();

    expect(trigger().textContent).toContain('Future group');
    expect(trigger().textContent).toContain('New group');
    openPicker();
    expect(
      option('automations-form-sidebar-group-option-unmatched').textContent,
    ).toContain('New group');
  });

  it('hydrates and switches group options when its scope changes', async () => {
    renderPicker({ scope: workspaceScope });
    await settle();
    expect(optionLabels()).toEqual(['No group', 'Team Review']);

    act(() => {
      root.render(
        <AutomationSidebarGroupPicker
          scope={coworkScope}
          value=""
          onChange={jest.fn()}
        />,
      );
    });
    await settle();

    expect(listGroups).toHaveBeenLastCalledWith(coworkScope);
    expect(optionLabels()).toEqual(['No group', 'Notes']);
  });

  it('rehydrates only when the matching scope changes', async () => {
    renderPicker({ scope: workspaceScope });
    await settle();
    const beforeChangeCount = listGroups.mock.calls.length;

    act(() => changedListener?.(appAdvisorScope));
    await settle();
    expect(listGroups).toHaveBeenCalledTimes(beforeChangeCount);

    act(() => changedListener?.(workspaceScope));
    await settle();
    expect(listGroups).toHaveBeenCalledTimes(beforeChangeCount + 1);
    expect(listGroups).toHaveBeenLastCalledWith(workspaceScope);
  });
});
