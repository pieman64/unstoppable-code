/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  resetRendererBillingLaneForTests,
  setRendererBillingLaneAvailability,
} from '@/stores/billingLaneRuntime';
import { useAiCreditsOnlyBilling } from '../useAiCreditsOnlyBilling';

function Probe(): JSX.Element {
  return <span data-testid="probe">{String(useAiCreditsOnlyBilling())}</span>;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mountProbe(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  const mounted = createRoot(container);
  root = mounted;
  act(() => mounted.render(<Probe />));
}

function probeText(): string | null | undefined {
  return container?.querySelector('[data-testid="probe"]')?.textContent;
}

afterEach(() => {
  const mounted = root;
  if (mounted) act(() => mounted.unmount());
  container?.remove();
  root = null;
  container = null;
  resetRendererBillingLaneForTests();
});

describe('useAiCreditsOnlyBilling', () => {
  it('is false before any billing-lane facts arrive', () => {
    mountProbe();
    expect(probeText()).toBe('false');
  });

  it('follows the facts in place without a remount', () => {
    mountProbe();

    act(() => {
      setRendererBillingLaneAvailability({
        claudeNativeAuth: false,
        codexNativeAuth: false,
        creditsEligible: true,
      });
    });
    expect(probeText()).toBe('true');

    act(() => {
      setRendererBillingLaneAvailability({
        claudeNativeAuth: true,
        codexNativeAuth: false,
        creditsEligible: true,
      });
    });
    expect(probeText()).toBe('false');
  });

  it('stays false while native access is still unknown', () => {
    mountProbe();

    act(() => {
      setRendererBillingLaneAvailability({
        claudeNativeAuth: undefined,
        codexNativeAuth: false,
        creditsEligible: true,
      });
    });
    expect(probeText()).toBe('false');
  });
});
