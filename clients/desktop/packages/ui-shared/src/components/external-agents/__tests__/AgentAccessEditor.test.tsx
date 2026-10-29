/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  AgentAccessEditor,
  type AgentAccessEditorProps,
} from '../AgentAccessEditor';
import type {
  AgentAccessGroupRow,
  AgentAccessToolRow,
} from '../agent-access-types';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

let root: Root;
let container: HTMLDivElement;

const tools: readonly AgentAccessToolRow[] = [
  {
    name: 'start_task',
    title: 'Start a cloud task',
    access: 'write',
    defaultOff: true,
    markers: ['spendsCredits', 'sendsEmail', 'publicEffect', 'actsOnRemote'],
    enabled: false,
    available: true,
  },
  {
    name: 'read_usage',
    title: 'Read usage',
    access: 'read',
    defaultOff: false,
    markers: [],
    enabled: false,
    available: false,
  },
];

const groups: readonly AgentAccessGroupRow[] = [
  {
    id: 'account',
    label: 'Account',
    description: 'Your profile and account settings.',
    level: 'read',
    levels: ['read'],
    writeUnavailableReason: 'Agents cannot change account settings.',
    tools: [],
  },
  {
    id: 'work',
    label: 'Cloud tasks',
    description: 'Projects and tasks in the cloud.',
    level: 'read',
    levels: ['off', 'read', 'write'],
    tools,
  },
  {
    id: 'pending',
    label: 'Remote control',
    description: 'Tasks on your computer.',
    level: 'off',
    levels: ['off', 'read'],
    unavailableReason: 'Not available yet',
    tools,
  },
];

function editorProps(): AgentAccessEditorProps {
  return {
    preset: 'read',
    onPresetChange: jest.fn(),
    groups,
    onLevelChange: jest.fn(),
    onDestructiveChange: jest.fn(),
    onToolChange: jest.fn(),
    toolCount: { enabled: 2, total: 4, max: 8 },
  };
}

function renderEditor(props: AgentAccessEditorProps): void {
  act(() => root.render(<AgentAccessEditor {...props} />));
}

function getByTestId(testId: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  if (!element) throw new Error(`Missing ${testId}`);
  return element;
}

function buttonByTestId(testId: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(
    `button[data-testid="${testId}"]`,
  );
  if (!element) throw new Error(`Missing button ${testId}`);
  return element;
}

function buttonWithText(parent: ParentNode, text: string): HTMLButtonElement {
  const element = Array.from(parent.querySelectorAll('button')).find(
    (button): boolean => button.textContent?.trim() === text,
  );
  if (!element) throw new Error(`Missing button ${text}`);
  return element;
}

function switchByLabel(label: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(
    `[role="switch"][aria-label="${label}"]`,
  );
  if (!element) throw new Error(`Missing switch ${label}`);
  return element;
}

function click(button: HTMLButtonElement): void {
  act(() => button.click());
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('reports preset changes', () => {
  const props = editorProps();
  renderEditor(props);

  click(buttonWithText(container, 'Read and write'));

  expect(props.onPresetChange).toHaveBeenCalledWith('write');
});

it('offers an unavailable Write level with its reason and changes available levels', () => {
  const props = editorProps();
  renderEditor(props);

  const accountPicker = getByTestId('agent-access-level-account');
  expect(
    Array.from(accountPicker.querySelectorAll('button')).some(
      (button): boolean => button.textContent?.trim() === 'Off',
    ),
  ).toBe(false);
  expect(accountPicker.querySelector('button')?.textContent?.trim()).toBe(
    'Read',
  );
  const unavailableWrite = buttonWithText(accountPicker, 'Write');
  expect(unavailableWrite.getAttribute('aria-disabled')).toBe('true');
  act(() => {
    unavailableWrite.dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true }),
    );
  });
  expect(document.body.textContent).toContain(
    'Agents cannot change account settings.',
  );

  const taskPicker = getByTestId('agent-access-level-work');
  click(buttonWithText(taskPicker, 'Write'));

  expect(props.onLevelChange).toHaveBeenCalledWith('work', 'write');
});

it('shows unavailable groups disabled with their reason and no tools disclosure', () => {
  renderEditor(editorProps());

  const row = getByTestId('agent-access-unavailable-pending');
  expect(row.textContent).toContain('Not available yet');
  expect(getByTestId('agent-access-group-pending')).not.toBeNull();
  expect(
    getByTestId('agent-access-level-pending').querySelector('button')?.disabled,
  ).toBe(true);
  expect(
    buttonWithText(
      getByTestId('agent-access-level-pending'),
      'Off',
    ).getAttribute('aria-pressed'),
  ).toBe('true');
  expect(
    container.querySelector(
      '[data-testid="agent-access-tools-toggle-pending"]',
    ),
  ).toBeNull();
});

it('shows a destructive switch only when its row provides one', () => {
  renderEditor(editorProps());

  expect(
    container.querySelector(
      '[data-testid="agent-access-destructive-switch-work"]',
    ),
  ).toBeNull();
});

it('labels and describes the destructive switch, including an unverified warning', () => {
  const props = editorProps();
  const work = groups.find((group) => group.id === 'work');
  if (work === undefined) throw new Error('Missing work group');
  renderEditor({
    ...props,
    groups: [
      ...groups.filter((group) => group.id !== 'work'),
      {
        ...work,
        destructive: {
          label: 'Allow deleting library items',
          description: 'Each deletion still asks you to confirm it.',
          enabled: false,
          warning:
            "This agent isn't verified. Allow this only if you trust it.",
        },
      },
    ],
  });

  const wrapper = getByTestId('agent-access-destructive-work');
  const toggle = container.querySelector<HTMLButtonElement>(
    '[data-testid="agent-access-destructive-switch-work"]',
  );
  if (toggle === null) throw new Error('Missing destructive switch');
  expect(toggle.getAttribute('role')).toBe('switch');
  expect(toggle.getAttribute('aria-label')).toBe(
    'Allow deleting library items',
  );
  expect(wrapper.querySelector('label')?.textContent).toBe(
    'Allow deleting library items',
  );

  const describedBy = toggle.getAttribute('aria-describedby')?.split(' ');
  expect(describedBy).toEqual([
    'agent-access-destructive-note-work',
    'agent-access-destructive-warning-work',
  ]);
  for (const id of describedBy ?? []) {
    expect(container.querySelector(`#${id}`)).not.toBeNull();
  }
  expect(getByTestId('agent-access-destructive-note-work').textContent).toBe(
    'Each deletion still asks you to confirm it.',
  );
  expect(
    getByTestId('agent-access-destructive-warning-work').textContent,
  ).toContain("This agent isn't verified. Allow this only if you trust it.");
});

it('reports destructive changes and never adds destructive tools to the tool list', () => {
  const props = editorProps();
  const work = groups.find((group) => group.id === 'work');
  if (work === undefined) throw new Error('Missing work group');
  renderEditor({
    ...props,
    groups: [
      ...groups.filter((group) => group.id !== 'work'),
      {
        ...work,
        destructive: {
          label: 'Allow deleting library items',
          description: 'Each deletion still asks you to confirm it.',
          enabled: false,
        },
      },
    ],
  });

  click(buttonByTestId('agent-access-destructive-switch-work'));
  expect(props.onDestructiveChange).toHaveBeenCalledWith('work', true);

  click(buttonByTestId('agent-access-tools-toggle-work'));
  expect(getByTestId('agent-access-tools-list-work').textContent).not.toContain(
    'Allow deleting library items',
  );
});

it('disables destructive switches when the editor is disabled', () => {
  const props = editorProps();
  const work = groups.find((group) => group.id === 'work');
  if (work === undefined) throw new Error('Missing work group');
  renderEditor({
    ...props,
    disabled: true,
    groups: [
      ...groups.filter((group) => group.id !== 'work'),
      {
        ...work,
        destructive: {
          label: 'Allow deleting library items',
          description: 'Each deletion still asks you to confirm it.',
          enabled: false,
        },
      },
    ],
  });

  expect(buttonByTestId('agent-access-destructive-switch-work').disabled).toBe(
    true,
  );
  click(buttonByTestId('agent-access-destructive-switch-work'));
  expect(props.onDestructiveChange).not.toHaveBeenCalled();
});

it('reveals tools and reports an enabled tool change', () => {
  const props = editorProps();
  renderEditor(props);

  const disclosure = buttonByTestId('agent-access-tools-toggle-work');
  expect(disclosure.getAttribute('aria-expanded')).toBe('false');
  expect(
    getByTestId('agent-access-tools-list-work').hasAttribute('hidden'),
  ).toBe(true);

  click(disclosure);

  expect(disclosure.getAttribute('aria-expanded')).toBe('true');
  expect(getByTestId('agent-access-tool-start_task')).not.toBeNull();
  click(switchByLabel('Start a cloud task'));

  expect(props.onToolChange).toHaveBeenCalledWith('work', 'start_task', true);
});

it('labels default-off tools and their access markers, and disables unavailable tools', () => {
  renderEditor(editorProps());
  click(buttonByTestId('agent-access-tools-toggle-work'));

  const expandedContent =
    getByTestId('agent-access-tools-list-work').textContent ?? '';
  expect(expandedContent).toContain('Off by default');
  expect(expandedContent).toContain('Spends AI credits');
  expect(expandedContent).toContain('Sends email');
  expect(expandedContent).toContain('Public');
  expect(expandedContent).toContain('Acts on your computer');
  expect(
    getByTestId('agent-access-tool-read_usage').querySelector('button')
      ?.disabled,
  ).toBe(true);
});

it('shows the enabled tool count and only warns when it exceeds the maximum', () => {
  const props = editorProps();
  renderEditor({ ...props, toolCount: { enabled: 8, total: 10, max: 8 } });

  expect(
    container.querySelector('[data-testid="agent-access-over-limit"]'),
  ).toBeNull();

  renderEditor({ ...props, toolCount: { enabled: 9, total: 10, max: 8 } });

  expect(getByTestId('agent-access-over-limit').textContent).toContain(
    'Turn off 1 to connect.',
  );

  renderEditor({ ...props, toolCount: { enabled: 7, total: 10, max: 8 } });
  expect(
    container.querySelector('[data-testid="agent-access-over-limit"]'),
  ).toBeNull();
});

it('counts every tool and names the limit only when the server has more', () => {
  const props = editorProps();
  renderEditor({ ...props, toolCount: { enabled: 41, total: 43, max: 80 } });
  expect(getByTestId('agent-access-tool-count').textContent).toBe(
    '41 of 43 tools on',
  );

  renderEditor({ ...props, toolCount: { enabled: 61, total: 90, max: 80 } });
  expect(getByTestId('agent-access-tool-count').textContent).toBe(
    '61 of 90 tools on (80 max)',
  );
});

it('disables every control when disabled', () => {
  const props = editorProps();
  renderEditor(props);
  click(buttonByTestId('agent-access-tools-toggle-work'));

  renderEditor({
    ...props,
    disabled: true,
    toolCount: { enabled: 9, total: 10, max: 8 },
  });

  const buttons = Array.from(container.querySelectorAll('button'));
  expect(buttons.length).toBeGreaterThan(0);
  expect(buttons.every((button): boolean => button.disabled)).toBe(true);
});
