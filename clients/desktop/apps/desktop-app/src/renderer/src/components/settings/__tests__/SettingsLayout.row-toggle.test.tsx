/**
 * @jest-environment jsdom
 */
import { act, type JSX, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ToggleSwitch } from '@canopy/ui-shared/components';
import { SettingsRow, SettingsSubRow } from '../SettingsLayout';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

function click(element: Element | null, detail = 1): void {
  if (!element) throw new Error('Missing click target');
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
  });
}

function query(testId: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  if (!element) throw new Error(`Missing ${testId}`);
  return element;
}

function isOn(): boolean {
  return query('switch').getAttribute('aria-checked') === 'true';
}

function ToggleRow({
  htmlFor,
  extraControl,
  sub,
}: {
  readonly htmlFor?: boolean;
  readonly extraControl?: JSX.Element;
  readonly sub?: boolean;
}): JSX.Element {
  const [checked, setChecked] = useState(false);
  const toggle = (
    <ToggleSwitch
      id="row-switch"
      checked={checked}
      label="Early access"
      onChange={setChecked}
      dataTestId="switch"
    />
  );
  const Row = sub ? SettingsSubRow : SettingsRow;
  return (
    <Row
      label={<span data-testid="label">Early access</span>}
      description={
        <span data-testid="description">
          Turn on features that are still being built.{' '}
          <code data-testid="code">**/*.lock</code>{' '}
          <a href="#docs" data-testid="link">
            Learn more
          </a>
        </span>
      }
      htmlFor={htmlFor ? 'row-switch' : undefined}
      control={
        <>
          {extraControl}
          {toggle}
        </>
      }
    />
  );
}

describe('settings rows with a single switch', () => {
  it('toggles from the label and the description', () => {
    render(<ToggleRow />);
    click(query('label'));
    expect(isOn()).toBe(true);
    click(query('description'));
    expect(isOn()).toBe(false);
  });

  it('toggles once when the label already names the switch', () => {
    render(<ToggleRow htmlFor />);
    click(query('label'));
    expect(isOn()).toBe(true);
    click(query('description'));
    expect(isOn()).toBe(false);
  });

  it('toggles from a sub-row', () => {
    render(<ToggleRow sub />);
    click(query('description'));
    expect(isOn()).toBe(true);
  });

  it('leaves links in the text and the switch itself alone', () => {
    render(<ToggleRow />);
    click(query('link'));
    expect(isOn()).toBe(false);
    click(query('switch'));
    expect(isOn()).toBe(true);
  });

  it('leaves copyable code values alone', () => {
    render(<ToggleRow />);
    click(query('code'));
    expect(isOn()).toBe(false);
  });

  it('flips once for a double click', () => {
    render(<ToggleRow />);
    click(query('description'), 1);
    click(query('description'), 2);
    expect(isOn()).toBe(true);
  });

  it('ignores a click that ends a text selection', () => {
    render(<ToggleRow />);
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(query('description'));
    selection?.removeAllRanges();
    selection?.addRange(range);
    click(query('description'));
    selection?.removeAllRanges();
    expect(isOn()).toBe(false);
  });

  it('does nothing when the row holds more than one switch', () => {
    render(
      <ToggleRow
        extraControl={
          <ToggleSwitch checked={false} label="Other" onChange={() => {}} />
        }
      />,
    );
    click(query('description'));
    expect(isOn()).toBe(false);
  });

  it('does nothing when the switch is disabled', () => {
    function DisabledRow(): JSX.Element {
      const [checked, setChecked] = useState(false);
      return (
        <SettingsRow
          label={<span data-testid="label">Early access</span>}
          control={
            <ToggleSwitch
              checked={checked}
              disabled
              label="Early access"
              onChange={setChecked}
              dataTestId="switch"
            />
          }
        />
      );
    }
    render(<DisabledRow />);
    click(query('label'));
    expect(isOn()).toBe(false);
  });
});
