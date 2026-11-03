/**
 * @jest-environment jsdom
 */
jest.mock('@/components/chat/ModelPicker', () => ({
  ModelPicker: ({
    currentModel,
    onModelChange,
  }: {
    currentModel: string;
    onModelChange: (model: string) => void;
  }): JSX.Element => (
    <button
      type="button"
      data-testid="mock-model-picker"
      data-current={currentModel}
      onClick={(): void => onModelChange('claude-sonnet-4-6')}
    >
      pick model
    </button>
  ),
}));

import { act, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PipelineModelAlias,
  PipelinePluginCollection,
} from '@canopy/desktop-shared/types/pipeline';
import { ModelAliasesEditor } from '../settings/ModelAliasesEditor';
import { useAgentsStore } from '@/stores/agentsStore';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PLUGIN_COLLECTIONS: PipelinePluginCollection[] = [
  { id: 'reviewers', name: 'Reviewers', defaults: [] },
];

let lastChange: PipelineModelAlias[] | undefined;

function Harness({
  initial,
  readonly = false,
}: {
  initial: PipelineModelAlias[];
  readonly?: boolean;
}): JSX.Element {
  const [aliases, setAliases] = useState<PipelineModelAlias[]>(initial);
  return (
    <ModelAliasesEditor
      aliases={aliases}
      pluginCollections={PLUGIN_COLLECTIONS}
      onChange={(next): void => {
        lastChange = next;
        setAliases(next ?? []);
      }}
      readonly={readonly}
    />
  );
}

function render(
  initial: PipelineModelAlias[],
  readonly = false,
): { container: HTMLElement; cleanup: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(<Harness initial={initial} readonly={readonly} />);
  });
  return {
    container,
    cleanup: (): void => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  });
}

// The React value tracker requires setting `value` through the native prototype
// setter (not the element instance) so the synthetic onChange fires.
function nativeValueSetter(
  proto: object,
): ((value: string) => void) | undefined {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked via .call, never as a bare method
  return Object.getOwnPropertyDescriptor(proto, 'value')?.set;
}

function setInputValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  v: string,
): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = nativeValueSetter(proto);
  act(() => {
    setter?.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Opens a shared dropdown and picks the option with this label. */
function chooseOption(trigger: HTMLElement, label: string): void {
  act(() => trigger.click());
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((candidate) => candidate.textContent === label);
  if (!option) throw new Error(`Missing option ${label}`);
  act(() => option.click());
}

function headerButton(container: HTMLElement, name: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(name),
  );
  if (!(btn instanceof HTMLButtonElement)) {
    throw new Error(`No header button containing "${name}"`);
  }
  return btn;
}

describe('ModelAliasesEditor', () => {
  beforeEach(() => {
    lastChange = undefined;
    act(() => {
      useAgentsStore.setState({
        agents: [
          {
            id: 'agent_model_reviewer',
            name: 'Reviewer Agent',
            baseModel: 'claude-sonnet-4-6',
            instructions: '',
            pluginSelections: {
              collectionIds: [],
              skillRefs: [],
              pluginRefs: [],
              mcpServerRefs: [],
            },
            createdAt: '',
            updatedAt: '',
          },
        ],
        loaded: true,
        load: jest.fn(() => Promise.resolve(undefined)),
      });
    });
  });

  it('renders the empty state', () => {
    const { container, cleanup } = render([]);
    expect(container.textContent).toContain('No model aliases defined');
    cleanup();
  });

  it('loads local Agents when aliases are present and the store is not hydrated', () => {
    const load = jest.fn(() => Promise.resolve(undefined));
    act(() => {
      useAgentsStore.setState({
        agents: [],
        loaded: false,
        load,
      });
    });

    const { cleanup } = render([{ id: 'a', name: 'Alias' }]);

    expect(load).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('adds a model alias without defaults', () => {
    const { container, cleanup } = render([]);
    click(headerButton(container, '+ Add model alias'));
    expect(lastChange).toEqual([
      { id: 'model-alias', name: 'New model alias' },
    ]);
    // A newly-added alias has no `defaults` and renders as required.
    expect(container.textContent).toContain('Required at dispatch/setup');
    cleanup();
  });

  it('edits the alias name, description, and id on blur', () => {
    const alias: PipelineModelAlias = { id: 'a', name: 'Alias' };
    const { container, cleanup } = render([alias]);
    click(headerButton(container, 'Alias'));

    // Edit name/description first: they keep the alias id (and thus the React
    // key) stable so the expanded item stays mounted.
    const nameInput = container.querySelector(
      'input[placeholder="Display name"]',
    ) as HTMLInputElement;
    setInputValue(nameInput, 'Reviewer');
    expect(lastChange?.[0].name).toBe('Reviewer');

    const descInput = container.querySelector(
      'textarea[placeholder="Describe this model alias…"]',
    ) as HTMLTextAreaElement;
    setInputValue(descInput, 'The reviewer alias');
    expect(lastChange?.[0].description).toBe('The reviewer alias');

    // Editing the id last (it changes the React key and remounts the item).
    const idInput = container.querySelector(
      'input[placeholder="reviewer"]',
    ) as HTMLInputElement;
    setInputValue(idInput, 'reviewer');
    // React registers onBlur as a `focusout` listener at the root.
    act(() => {
      idInput.dispatchEvent(new Event('focusout', { bubbles: true }));
    });
    expect(lastChange?.[0].id).toBe('reviewer');
    cleanup();
  });

  it('rejects alias ids that do not start with a letter or number', () => {
    const alias: PipelineModelAlias = { id: 'a', name: 'Alias' };
    const { container, cleanup } = render([alias]);
    click(headerButton(container, 'Alias'));

    const idInput = container.querySelector(
      'input[placeholder="reviewer"]',
    ) as HTMLInputElement;
    setInputValue(idInput, '-bad');

    expect(container.textContent).toContain('Start with a letter or number');

    act(() => {
      idInput.dispatchEvent(new Event('focusout', { bubbles: true }));
    });

    expect(lastChange).toBeUndefined();
    cleanup();
  });

  it('switches to inline and Agent mode, and back to no default', () => {
    const alias: PipelineModelAlias = { id: 'a', name: 'Alias' };
    const { container, cleanup } = render([alias]);
    click(headerButton(container, 'Alias'));

    const modeSelect = container.querySelector(
      '[data-testid="model-alias-a-mode"]',
    );
    if (!(modeSelect instanceof HTMLElement)) throw new Error('Missing mode');

    chooseOption(modeSelect, 'Inline model');
    expect(lastChange?.[0].defaults).toEqual({ base: '' });

    // Choose a base model via the mocked picker.
    const picker = container.querySelector(
      '[data-testid="mock-model-picker"]',
    ) as HTMLButtonElement;
    click(picker);
    expect(lastChange?.[0].defaults).toEqual({ base: 'claude-sonnet-4-6' });

    // Select a plugin collection.
    const pcSelect = Array.from(
      container.querySelectorAll<HTMLElement>('[role="combobox"]'),
    ).find((candidate) => candidate !== modeSelect);
    if (!pcSelect) throw new Error('Missing plugin collection select');
    chooseOption(pcSelect, 'Reviewers (reviewers)');
    expect(lastChange?.[0].defaults).toEqual({
      base: 'claude-sonnet-4-6',
      plugin_collection_id: 'reviewers',
    });

    chooseOption(modeSelect, 'Agent');
    expect(lastChange?.[0].defaults).toEqual({
      agent_id: 'agent_model_reviewer',
    });

    chooseOption(modeSelect, 'No default');
    expect(lastChange?.[0].defaults).toBeUndefined();
    cleanup();
  });

  it('removes an alias', () => {
    const alias: PipelineModelAlias = { id: 'a', name: 'Alias' };
    const { container, cleanup } = render([alias]);
    const removeBtn = container.querySelector(
      '[aria-label="Remove model alias"]',
    ) as HTMLElement;
    click(removeBtn);
    expect(lastChange).toBeUndefined();
    cleanup();
  });

  it('hides add/remove and disables fields when readonly', () => {
    const alias: PipelineModelAlias = { id: 'a', name: 'Alias' };
    const { container, cleanup } = render([alias], true);
    expect(
      container.querySelector('[aria-label="Remove model alias"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain('+ Add model alias');
    click(headerButton(container, 'Alias'));
    const idInput = container.querySelector(
      'input[placeholder="reviewer"]',
    ) as HTMLInputElement;
    expect(idInput.disabled).toBe(true);
    cleanup();
  });
});
