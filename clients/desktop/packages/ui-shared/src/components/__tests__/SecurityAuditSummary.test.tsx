/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { SecurityAuditSummary } from '../SecurityAuditSummary';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('SecurityAuditSummary', () => {
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

  it('shows the risk level as a badge with the scan caption', () => {
    act(() => {
      root.render(
        <SecurityAuditSummary
          audit={{ level: 'safe', socketAlerts: 0 }}
          dataTestId="audit"
        />,
      );
    });
    const summary = container.querySelector('[data-testid="audit"]');
    expect(summary?.textContent).toContain('Security scan');
    expect(summary?.textContent).toContain('safe');
    expect(summary?.textContent).not.toContain('alert');
    // The shared RiskBadge renders the level; the stacked "Risk level"
    // caption it uses in skill rows must not appear inline here.
    expect(summary?.textContent).not.toContain('Risk level');
  });

  it('counts Socket alerts with the right plural', () => {
    act(() => {
      root.render(
        <SecurityAuditSummary
          audit={{ level: 'high', socketAlerts: 1 }}
          dataTestId="one"
        />,
      );
    });
    expect(
      container.querySelector('[data-testid="one"]')?.textContent,
    ).toContain('1 Socket alert');
    act(() => {
      root.render(
        <SecurityAuditSummary
          audit={{ level: 'high', socketAlerts: 3 }}
          dataTestId="many"
        />,
      );
    });
    expect(
      container.querySelector('[data-testid="many"]')?.textContent,
    ).toContain('3 Socket alerts');
  });

  it('says the scan is not available instead of showing an unknown badge', () => {
    act(() => {
      root.render(
        <SecurityAuditSummary
          audit={{ level: 'unknown', socketAlerts: null }}
          dataTestId="unavailable"
        />,
      );
    });
    const summary = container.querySelector('[data-testid="unavailable"]');
    expect(summary?.textContent).toBe('Security scan: not available');
    // Never "pending": the service may never index this repository.
    expect(summary?.textContent).not.toContain('pending');
  });
});
