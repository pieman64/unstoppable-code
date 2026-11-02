/**
 * @jest-environment jsdom
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdvancedDisclosure } from '../AdvancedDisclosure';
import { DialogFormField } from '../DialogFormField';
import { DialogModal } from '../DialogModal';
import { SettingsSelect } from '../SettingsSelect';
import { ChoiceList, ChoiceListRow } from '../ChoiceList';
import { TextLinkButton } from '../ExternalTextLink';
import {
  ProviderRowLabel,
  ProviderStatusDot,
  type ProviderStatusDotTone,
} from '../ProviderRowLabel';
import { SettingsButtonRow } from '../settings/SettingsButtonRow';
import {
  SettingsSaveBar,
  SettingsSaveBarSlotContext,
} from '../settings/SettingsSaveBar';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLElement;
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

function render(node: ReactElement): void {
  act(() => root.render(node));
}

function byTestId(testId: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  if (!node) throw new Error(`Missing ${testId}`);
  return node;
}

describe('ChoiceList', () => {
  it('is a hairline box of whole-row toggles marked by the neutral choice mark', () => {
    const onClick = jest.fn();
    render(
      <ChoiceList aria-label="Projects" data-testid="list">
        <ChoiceListRow selected data-testid="on" onClick={onClick}>
          Alpha
        </ChoiceListRow>
        <ChoiceListRow selected={false} data-testid="off" trailing="2 repos">
          Beta
        </ChoiceListRow>
      </ChoiceList>,
    );
    const list = byTestId('list');
    expect(list.getAttribute('role')).toBe('group');
    expect(list.getAttribute('aria-label')).toBe('Projects');
    expect(list.className).toContain('ring-[length:var(--border-hairline)]');
    expect(list.className).not.toContain('ring-1');

    const on = byTestId('on');
    const off = byTestId('off');
    expect(on.getAttribute('aria-pressed')).toBe('true');
    expect(off.getAttribute('aria-pressed')).toBe('false');
    // Selection is the mark alone: no accent and no selected fill on the row.
    for (const row of [on, off]) {
      expect(row.className).not.toMatch(/accent/);
      expect(row.className).not.toContain('bg-selected');
      expect(row.className).toContain('hover:bg-subtle');
    }
    expect(on.querySelector('.bg-fg-primary')).toBeInstanceOf(Element);
    expect(off.querySelector('.bg-fg-primary')).toBeNull();
    expect(off.textContent).toContain('2 repos');

    act(() => on.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('SettingsButtonRow', () => {
  it('keeps the settings row height and marks the chosen row with a check only', () => {
    render(
      <>
        <SettingsButtonRow
          trailing="select"
          selected
          label="Work"
          data-testid="chosen"
        />
        <SettingsButtonRow
          trailing="select"
          selected={false}
          label="Personal"
          data-testid="other"
        />
      </>,
    );
    const chosen = byTestId('chosen');
    const other = byTestId('other');
    expect(chosen.className).toContain('min-h-10');
    expect(chosen.getAttribute('aria-pressed')).toBe('true');
    expect(other.getAttribute('aria-pressed')).toBe('false');
    expect(chosen.className).not.toMatch(/accent/);
    expect(chosen.querySelector('svg')).toBeInstanceOf(Element);
    expect(other.querySelector('svg')).toBeNull();
    expect(chosen.getAttribute('data-settings-control')).toBe('row');
  });

  it('opens what it names with a chevron after its details', () => {
    const onClick = jest.fn();
    render(
      <SettingsButtonRow
        trailing="open"
        label="Staging"
        description="Inherits Overall"
        meta={<span data-testid="meta">2 uses</span>}
        data-testid="row"
        onClick={onClick}
      />,
    );
    const row = byTestId('row');
    expect(row.hasAttribute('aria-pressed')).toBe(false);
    expect(row.textContent).toBe('StagingInherits Overall2 uses');
    expect(row.querySelector('svg')).toBeInstanceOf(Element);
    act(() => row.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('ProviderStatusDot', () => {
  it('maps each connection state to one shared dot', () => {
    const tones: readonly (readonly [ProviderStatusDotTone, string])[] = [
      ['connected', 'bg-success'],
      ['failed', 'bg-destructive'],
      ['limited', 'bg-warning'],
      ['pending', 'bg-info'],
      ['idle', 'bg-fg-tertiary'],
      ['signed-out', 'ring-fg-quaternary'],
    ];
    for (const [tone, className] of tones) {
      const html = renderToStaticMarkup(<ProviderStatusDot tone={tone} />);
      expect(html).toContain(className);
      expect(html).toContain('h-2.5 w-2.5');
      expect(html).toContain('aria-hidden="true"');
    }
  });

  it('names its state when the row text does not', () => {
    render(
      <ProviderRowLabel
        name="Account"
        status={
          <ProviderStatusDot
            tone="limited"
            label="At a limit"
            data-testid="dot"
            data-status="cooling"
          />
        }
      />,
    );
    const dot = byTestId('dot');
    expect(dot.getAttribute('role')).toBe('img');
    expect(dot.getAttribute('aria-label')).toBe('At a limit');
    expect(dot.hasAttribute('aria-hidden')).toBe(false);
    expect(dot.getAttribute('data-status')).toBe('cooling');
  });
});

describe('TextLinkButton', () => {
  it('is the inline accent text link, sized by the copy around it', () => {
    const onClick = jest.fn();
    render(
      <p className="text-xs">
        Read the <TextLinkButton onClick={onClick}>guide</TextLinkButton>.
      </p>,
    );
    const button = container.querySelector('button');
    expect(button?.getAttribute('type')).toBe('button');
    expect(button?.className).toContain('fg-accent');
    expect(button?.className).toContain('hover:underline');
    expect(button?.className).not.toMatch(/\btext-(xs|s|m)\b/);
    act(() => button?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('AdvancedDisclosure', () => {
  it('draws a leading mark after the chevron and names the region it opens', () => {
    render(
      <AdvancedDisclosure
        label="Only have a Grok account?"
        dataTestId="hint"
        leadingIcon={<svg data-testid="mark" />}
      >
        Body
      </AdvancedDisclosure>,
    );
    const toggle = byTestId('hint-toggle');
    expect(toggle.textContent).toBe('Only have a Grok account?');
    expect(toggle.contains(byTestId('mark'))).toBe(true);
    expect(toggle.hasAttribute('aria-controls')).toBe(false);
    act(() => toggle.click());
    const body = byTestId('hint-body');
    expect(toggle.getAttribute('aria-controls')).toBe(body.id);
  });
});

describe('DialogModal footer and form fields', () => {
  it('draws the actions in the footer after the body, never beside the title', () => {
    render(
      <DialogModal
        title="What kind of work do you do?"
        onClose={(): void => undefined}
        dataTestId="dialog"
        footer={<button data-testid="save">Save</button>}
      >
        <p data-testid="body">Body</p>
      </DialogModal>,
    );
    const card = document.querySelector('[data-testid="dialog"]');
    const footer = card?.querySelector('[data-dialog-footer]');
    expect(footer).toBeInstanceOf(Element);
    expect(footer?.querySelector('[data-testid="save"]')).toBeInstanceOf(
      Element,
    );
    expect(footer?.className).toContain('justify-end');
    // The footer is the card's last child, after the body.
    expect(card?.lastElementChild).toBe(footer);
    const heading = card?.querySelector('h2');
    expect(
      heading?.parentElement?.parentElement?.contains(footer ?? null),
    ).toBe(false);
  });

  it('fills the dialog width with a Settings dropdown in a form field', () => {
    render(
      <>
        <SettingsSelect
          aria-label="Row"
          data-testid="row"
          options={[{ value: 'a', label: 'A' }]}
          value="a"
          onValueChange={(): void => undefined}
        />
        <DialogFormField label="Agent runtime">
          <SettingsSelect
            aria-label="Field"
            data-testid="field"
            options={[{ value: 'a', label: 'A' }]}
            value="a"
            onValueChange={(): void => undefined}
          />
        </DialogFormField>
      </>,
    );
    expect(byTestId('row').className).toContain('w-36');
    expect(byTestId('row').className).not.toContain('w-full');
    expect(byTestId('field').className).toContain('w-full');
    expect(container.textContent).toContain('Agent runtime');
  });
});

describe('SettingsSaveBar', () => {
  it('renders into the card slot below the scroll area when one is provided', () => {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    render(
      <SettingsSaveBarSlotContext.Provider value={slot}>
        <div data-testid="page">
          <SettingsSaveBar
            dataTestId="bar"
            status="Unsaved changes"
            actions={<button>Save changes</button>}
          />
        </div>
      </SettingsSaveBarSlotContext.Provider>,
    );
    const bar = slot.querySelector('[data-testid="bar"]');
    expect(bar).toBeInstanceOf(Element);
    expect(byTestId('page').querySelector('[data-testid="bar"]')).toBeNull();
    expect(bar?.className).toContain('bg-secondary');
    expect(bar?.className).not.toContain('sticky');
    expect(bar?.firstElementChild?.className).toContain('bg-line-base');
    expect(bar?.textContent).toContain('Unsaved changes');
    slot.remove();
  });

  it('sticks to the bottom of the page column without a slot', () => {
    render(
      <SettingsSaveBar
        dataTestId="bar"
        actions={<button>Save changes</button>}
      />,
    );
    expect(byTestId('bar').className).toContain('sticky');
  });
});

describe('SettingsButtonRow tooltip', () => {
  it('shows a truncated label in the shared tooltip, never a native title', () => {
    render(
      <SettingsButtonRow
        trailing="open"
        label="Cowork Settings · Agent Runtime"
        tooltip="Cowork Settings · Agent Runtime"
        data-testid="row"
      />,
    );
    const row = byTestId('row');
    expect(row.hasAttribute('title')).toBe(false);
    expect(row.parentElement?.className).toContain('w-full');
  });
});
