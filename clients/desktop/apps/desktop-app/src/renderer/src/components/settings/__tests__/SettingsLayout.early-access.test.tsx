/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import { act, type JSX, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Button, Notice } from '@canopy/ui-shared/components';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSegmentedControl,
} from '../SettingsLayout';

function SettingsAction(): JSX.Element {
  return <Button size="compact">Browse</Button>;
}

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
  writable: true,
});

let host: HTMLDivElement;
let root: Root;

// Rendered on the client: server rendering reads the store's initial state.
function renderSettingsPage(): HTMLElement {
  act(() =>
    root.render(
      <SettingsPage title="General">
        <Notice data-testid="page-notice">Page banner</Notice>
        <SettingsSection title="Workspace">
          <Notice data-testid="section-notice">Section banner</Notice>
          <SettingsGroup>
            <SettingsRow
              label="Mode"
              control={
                <>
                  <SettingsAction />
                  <SettingsSegmentedControl
                    value="a"
                    options={[
                      { value: 'a', label: 'A' },
                      { value: 'b', label: 'B' },
                    ]}
                    onChange={(): void => undefined}
                    label="Mode"
                    dataTestId="mode-picker"
                  />
                </>
              }
            >
              <Notice data-testid="row-notice">Row banner</Notice>
            </SettingsRow>
          </SettingsGroup>
        </SettingsSection>
      </SettingsPage>,
    ),
  );
  return host;
}

// A row control with a save in flight: local state that a remount would drop.
function PendingSave(): JSX.Element {
  const [saving, setSaving] = useState(false);
  return (
    <Button
      data-testid="pending-save"
      disabled={saving}
      onClick={(): void => setSaving(true)}
    >
      {saving ? 'Saving' : 'Save'}
    </Button>
  );
}

function shapeOf(host: HTMLElement, testId: string): string | null {
  return (
    host
      .querySelector(`[data-testid="${testId}"]`)
      ?.getAttribute('data-notice-shape') ?? null
  );
}

function classesOf(host: HTMLElement, selector: string): string[] {
  return host.querySelector(selector)?.className.split(/\s+/) ?? [];
}

describe('Settings pages and early access', () => {
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    resetExperimentalFeaturesStoreForTest();
  });

  it('uses compact Settings controls without a Labs opt-in', () => {
    const page = renderSettingsPage();

    expect(shapeOf(page, 'page-notice')).toBe('settings');
    expect(shapeOf(page, 'section-notice')).toBe('settings');
    expect(shapeOf(page, 'row-notice')).toBe('default');
    const button = classesOf(page, 'button:not([aria-pressed])');
    expect(button).toContain('rounded-full');
    expect(button).toContain('px-3');
    const picker = classesOf(page, '[data-testid="mode-picker"]');
    expect(picker).not.toContain('rounded-md');
    expect(picker).toContain('rounded-full');
  });

  it('aligns page-level notices with the settings cards and uses capsules with early access on', () => {
    setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    const page = renderSettingsPage();

    expect(shapeOf(page, 'page-notice')).toBe('settings');
    expect(shapeOf(page, 'section-notice')).toBe('settings');
    // A notice inside a row is part of that row's content, not a card.
    expect(shapeOf(page, 'row-notice')).toBe('default');
    const button = classesOf(page, 'button:not([aria-pressed])');
    expect(button).toContain('rounded-full');
    expect(button).toContain('px-3');
    expect(button).not.toContain('rounded-md');
    const picker = classesOf(page, '[data-testid="mode-picker"]');
    expect(picker).toContain('rounded-full');
    expect(picker).not.toContain('rounded-md');
  });

  it('keeps row state, such as a pending save, when early access changes', () => {
    act(() =>
      root.render(
        <SettingsPage title="General">
          <SettingsSection title="Workspace">
            <SettingsGroup>
              <SettingsRow label="Mode" control={<PendingSave />} />
            </SettingsGroup>
          </SettingsSection>
        </SettingsPage>,
      ),
    );
    const save = (): HTMLButtonElement | null =>
      host.querySelector('[data-testid="pending-save"]');
    act(() => save()?.click());
    expect(save()?.disabled).toBe(true);

    act(() => setTestEarlyAccessFeatures({ enabled: true, hydrated: true }));
    expect(save()?.disabled).toBe(true);
    expect(save()?.textContent).toBe('Saving');

    act(() => setTestEarlyAccessFeatures({ enabled: false, hydrated: true }));
    expect(save()?.disabled).toBe(true);
    expect(save()?.textContent).toBe('Saving');
  });
});
