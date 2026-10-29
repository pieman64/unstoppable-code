/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LabsExperimentsSectionLayout } from '@canopy/ui-shared/components';
import { LabsSettingsSection } from '../LabsSettingsSection';
import {
  LabsSettingsPortProvider,
  type LabsSettingsPort,
} from '../labs-settings-port';

const ROW = {
  id: 'clean-chat',
  name: 'Clean chat',
  description: 'A quieter chat.',
  checked: false,
  disabled: false,
  group: 'pages',
} as const;

function render(node: ReactNode): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return { container, root };
}

function withPort(port: LabsSettingsPort): ReactNode {
  return (
    <LabsSettingsPortProvider value={port}>
      <LabsSettingsSection />
    </LabsSettingsPortProvider>
  );
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('LabsSettingsSection', () => {
  it('renders nothing without a host port', () => {
    const { container, root } = render(<LabsSettingsSection />);
    expect(container.innerHTML).toBe('');
    act(() => root.unmount());
  });

  it('lists the port rows in the card kit and reports a toggle', () => {
    const onToggle = jest.fn();
    const { container, root } = render(
      withPort({ rows: [ROW], error: null, onToggle }),
    );
    const section = container.querySelector('section');
    expect(section?.className).toContain('rounded-xl');
    expect(container.textContent).toContain('Clean chat');
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="labs-experiment-toggle-clean-chat"]',
    );
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    act(() => toggle?.click());
    expect(onToggle).toHaveBeenCalledWith('clean-chat', true);
    act(() => root.unmount());
  });

  it("uses the host's layout kit when it supplies one", () => {
    const layout: LabsExperimentsSectionLayout = {
      Section: ({ children }) => (
        <div data-testid="host-section">{children}</div>
      ),
      Group: ({ children }) => <div>{children}</div>,
      Row: ({ label, control }) => (
        <div data-testid="host-row">
          {label}
          {control}
        </div>
      ),
    };
    const { container, root } = render(
      withPort({ rows: [ROW], error: null, onToggle: jest.fn(), layout }),
    );
    expect(container.querySelector('[data-testid="host-section"]')).not.toBe(
      null,
    );
    expect(container.querySelector('section')).toBe(null);
    act(() => root.unmount());
  });
});
