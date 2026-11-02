/**
 * @jest-environment jsdom
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyApi,
  UpdatePhase,
  UpdateState,
} from '@canopy/desktop-shared/types';
import { useUpdateState } from '@/hooks/useUpdateState';
import { UpdatePrompt } from '../UpdatePrompt';
import { brand } from '@/lib/brand';

jest.mock('@/lib/brand', () => ({
  brand: { id: 'unstoppable-code', displayName: 'Example' },
}));

jest.mock('@/hooks/useUpdateState', () => ({
  useUpdateState: jest.fn(),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP_SOURCE = readFileSync(
  join(__dirname, '..', '..', '..', 'App.tsx'),
  'utf-8',
);
const APP_SIDEBAR_SOURCE = readFileSync(
  join(__dirname, '..', 'AppSidebar.tsx'),
  'utf-8',
);
const downloadUpdateMock = jest.fn<Promise<void>, []>(() => Promise.resolve());
const installUpdateMock = jest.fn<Promise<void>, []>(() => Promise.resolve());
const checkForUpdatesMock = jest.fn<Promise<void>, []>(() => Promise.resolve());
const scheduleUpdateMock = jest.fn<Promise<void>, []>(() => Promise.resolve());
const cancelScheduledUpdateMock = jest.fn<Promise<void>, []>(() =>
  Promise.resolve(),
);
const openExternalMock = jest.fn<
  ReturnType<CanopyApi['browser']['openExternal']>,
  [request: Parameters<CanopyApi['browser']['openExternal']>[0]]
>(() => Promise.resolve());
const originalPlatform = window.platform;

let container: HTMLDivElement;
let root: Root;

function mockUpdateState(state: UpdateState): void {
  jest.mocked(useUpdateState).mockReturnValue({
    appVersion: '0.26.8',
    dependencyVersions: null,
    state,
    refresh: (): Promise<void> => Promise.resolve(),
  });
}

function render(element: ReactNode): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(element);
  });
}

function queryPrompt(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="update-prompt"]');
}

describe('removed lower-right update notification', () => {
  it('does not import or mount the obsolete update card at the app root', () => {
    expect(APP_SOURCE).not.toContain('UpdateNotification');
    expect(APP_SOURCE).not.toContain('updateNotificationRequests');
  });
});

describe('sidebar update prompt', () => {
  beforeEach(() => {
    brand.id = 'unstoppable-code';
    Reflect.set(globalThis, '__CANOPY_RELEASE_FLAVOR__', 'stable');
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    downloadUpdateMock.mockClear();
    installUpdateMock.mockClear();
    checkForUpdatesMock.mockClear();
    scheduleUpdateMock.mockClear();
    cancelScheduledUpdateMock.mockClear();
    openExternalMock.mockClear();
    const api = {
      browser: { openExternal: openExternalMock },
      update: {
        downloadUpdate: downloadUpdateMock,
        installUpdate: installUpdateMock,
        checkForUpdates: checkForUpdatesMock,
        scheduleUpdate: scheduleUpdateMock,
        cancelScheduledUpdate: cancelScheduledUpdateMock,
        reportBusyState: jest.fn<Promise<void>, [busy: boolean]>(() =>
          Promise.resolve(),
        ),
        getAppVersion: jest.fn<Promise<string>, []>(() =>
          Promise.resolve('0.26.8'),
        ),
        getDependencyVersions: jest.fn<
          ReturnType<CanopyApi['update']['getDependencyVersions']>,
          []
        >(() =>
          Promise.resolve({
            claudeCli: '',
            claudeSdk: '',
            codexCli: '',
            ghCli: '',
            octokit: '',
            rtkCli: '',
          }),
        ),
        getState: jest.fn<ReturnType<CanopyApi['update']['getState']>, []>(() =>
          Promise.resolve({ phase: 'idle' }),
        ),
        onUpdateEvent: jest.fn<
          ReturnType<CanopyApi['update']['onUpdateEvent']>,
          [callback: Parameters<CanopyApi['update']['onUpdateEvent']>[0]]
        >(() => (): void => {}),
      },
    } satisfies {
      browser: Pick<CanopyApi['browser'], 'openExternal'>;
      update: CanopyApi['update'];
    };
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: api,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    Reflect.deleteProperty(window, 'api');
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: originalPlatform,
    });
  });

  it('opens only the verified manual download on Linux without installer actions', () => {
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'linux',
    });
    const url =
      'https://releases.unstoppable.ai/desktop/example/1.2.0/example-1.2.0-linux-amd64.deb';
    mockUpdateState({
      phase: 'available',
      info: {
        version: '1.2.0',
        manualDownload: {
          url,
          guidance:
            'Verify the checksum before installing with your package manager.',
          checksum: { algorithm: 'SHA-512', value: 'a'.repeat(128) },
        },
      },
    });
    render(<UpdatePrompt />);
    const prompt = queryPrompt();
    expect(prompt?.textContent).toBe('Reinstall Linux package');
    expect(container.textContent).toContain(
      'sudo apt update && sudo apt upgrade',
    );
    expect(container.textContent).toContain(
      'install the current official .deb once more',
    );
    act(() => {
      prompt?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(
      document.body.querySelector('[role="tooltip"]')?.textContent,
    ).toContain(`SHA-512: ${'a'.repeat(128)}`);
    act(() => {
      prompt?.click();
    });
    expect(openExternalMock).toHaveBeenCalledWith({ url });
    expect(downloadUpdateMock).not.toHaveBeenCalled();
    expect(installUpdateMock).not.toHaveBeenCalled();
    expect(scheduleUpdateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['unstoppable-code', 'internal'],
    ['unstoppable-code', 'rc'],
    ['canopy', 'stable'],
  ])('keeps %s %s on direct downloads without APT promises', (id, flavor) => {
    brand.id = id;
    Reflect.set(globalThis, '__CANOPY_RELEASE_FLAVOR__', flavor);
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'linux',
    });
    mockUpdateState({
      phase: 'available',
      info: {
        version: '1.2.0',
        manualDownload: {
          url: 'https://example.invalid/update.deb',
          guidance: 'Verify its checksum.',
          checksum: { algorithm: 'SHA-512', value: 'a'.repeat(128) },
        },
      },
    });
    render(<UpdatePrompt />);
    expect(queryPrompt()?.textContent).toBe('Download Linux update');
    expect(container.textContent).not.toMatch(/APT|apt update|once more/);
  });

  it('does not expose a restart for stale downloaded events on Linux', () => {
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'linux',
    });
    mockUpdateState({
      phase: 'downloaded',
      installPending: true,
      info: { version: '1.2.0' },
    });
    render(<UpdatePrompt />);
    expect(queryPrompt()).toBeNull();
    expect(installUpdateMock).not.toHaveBeenCalled();
  });

  it('renders the available prompt with the shared footer-banner treatment', () => {
    mockUpdateState({
      phase: 'available',
      info: { version: '0.29.0' },
    });
    render(<UpdatePrompt />);

    const prompt = queryPrompt();
    expect(prompt).not.toBeNull();
    expect(prompt?.tagName).toBe('BUTTON');
    expect(prompt?.textContent).toBe('Update available');
    expect(prompt?.className).toContain('h-7');
    expect(prompt?.className).toContain('rounded-row');
    expect(prompt?.className).toContain('text-xs');
    expect(prompt?.className).toContain('bg-quaternary');
    expect(prompt?.className).toContain('shadow-md');
    // Labels are fg-primary in both modes; semantic tone lives in the icon.
    expect(prompt?.className).toContain('fg-primary');
    expect(prompt?.className).not.toContain('fg-accent');
    expect(prompt?.className).toContain('bg-quaternary');
    // Neutral elevated card in both modes — no semantic tint; hover uses the
    // shared neutral wash.
    expect(prompt?.className).not.toContain('color-mix');
    expect(prompt?.className).toContain(
      'hover:[background-image:linear-gradient(var(--bg-subtle),var(--bg-subtle))]',
    );
    const iconBox = prompt?.firstElementChild;
    expect(iconBox?.className).toContain('fg-accent');
    const downloadIcon = prompt?.querySelector('[data-app-icon="true"]');
    expect(downloadIcon?.getAttribute('width')).toBe('14px');
    expect(downloadIcon?.getAttribute('height')).toBe('14px');
    expect(
      prompt?.querySelector('[data-testid="update-prompt-dot"]'),
    ).toBeNull();
    expect(prompt?.getAttribute('aria-label')).toBe(
      'Update available (v0.29.0): start download',
    );
  });

  it('acknowledges a download click immediately and starts the download', () => {
    mockUpdateState({
      phase: 'available',
      info: { version: '0.29.0' },
    });
    render(<UpdatePrompt />);

    act(() => {
      queryPrompt()?.click();
    });

    expect(downloadUpdateMock).toHaveBeenCalledTimes(1);
    const prompt = queryPrompt();
    expect(prompt?.tagName).toBe('DIV');
    expect(prompt?.textContent).toContain('Starting download…');
  });

  it('shows live progress as a non-interactive status while downloading', () => {
    mockUpdateState({
      phase: 'downloading',
      info: { version: '0.29.0' },
      progress: {
        percent: 42,
        bytesPerSecond: 1,
        transferred: 42,
        total: 100,
      },
    });
    render(<UpdatePrompt />);

    const prompt = queryPrompt();
    expect(prompt?.tagName).toBe('DIV');
    expect(prompt?.getAttribute('role')).toBe('status');
    expect(prompt?.textContent).toContain('Updating…');
    // Labels are fg-primary in both modes; the loader carries the accent
    // tone.
    expect(prompt?.className).toContain('fg-primary');
    expect(prompt?.className).not.toContain('fg-accent');
    // The shared LoadingSpinner (3×3 dot grid) replaces any ad-hoc spinner.
    const loader = prompt?.querySelector('[aria-label="Loading"]');
    expect(loader).not.toBeNull();
    expect(loader?.className).toContain('fg-accent');
    const percent = prompt?.querySelector(
      '[data-testid="update-prompt-percent"]',
    );
    expect(percent?.textContent).toBe('42%');
    expect(percent?.className).toContain('fg-primary');
    expect(percent?.className).toContain('text-2xs');
    // The percent sits on the banner's own pr-2 inset — no extra margin.
    expect(percent?.className).not.toContain('mr-0.5');
    expect(prompt?.getAttribute('aria-label')).toBe(
      'Downloading update v0.29.0 (42%)',
    );
    act(() => {
      prompt?.click();
    });
    expect(downloadUpdateMock).not.toHaveBeenCalled();
  });

  it('offers a restart action once the update is downloaded', () => {
    mockUpdateState({
      phase: 'downloaded',
      info: { version: '0.29.0' },
    });
    render(<UpdatePrompt />);

    const prompt = queryPrompt();
    expect(prompt?.tagName).toBe('BUTTON');
    expect(prompt?.textContent).toContain('Restart to update');
    expect(prompt?.getAttribute('aria-label')).toBe(
      'Update ready (v0.29.0): restart to install',
    );

    act(() => {
      prompt?.click();
    });
    expect(installUpdateMock).toHaveBeenCalledTimes(1);
    expect(queryPrompt()?.textContent).toContain('Restarting…');
  });

  it('offers an install-when-idle action once the update is downloaded', () => {
    mockUpdateState({
      phase: 'downloaded',
      info: { version: '0.29.0' },
    });
    render(<UpdatePrompt />);

    // The banner splits into two sibling buttons (no nested buttons): the
    // primary restart action plus the trailing schedule action.
    const row = container.querySelector<HTMLElement>(
      '[data-testid="update-prompt-row"]',
    );
    expect(row?.tagName).toBe('DIV');
    // The row-level hover wash is keyed off the primary button only, so
    // hovering the trailing icon button highlights just itself.
    expect(row?.className).toContain(
      'has-[[data-banner-primary]:hover]:[background-image:linear-gradient(var(--bg-subtle),var(--bg-subtle))]',
    );
    expect(row?.className).not.toContain(
      'hover:[background-image:linear-gradient',
    );
    expect(queryPrompt()?.hasAttribute('data-banner-primary')).toBe(true);
    // The split row must NOT clip: focus-visible outlines draw outside the
    // buttons (2px outline at 2px offset) and overflow-hidden would hide
    // them. Truncation lives on the primary button instead.
    expect(row?.className).not.toContain('overflow-hidden');
    expect(queryPrompt()?.className).toContain('overflow-hidden');
    const schedule = container.querySelector<HTMLElement>(
      '[data-testid="update-prompt-schedule"]',
    );
    expect(schedule?.tagName).toBe('BUTTON');
    expect(schedule?.getAttribute('aria-label')).toBe(
      'Install v0.29.0 when all agents are idle',
    );
    // The shared Tooltip owns the hover label; no native title attribute.
    expect(schedule?.hasAttribute('title')).toBe(false);

    act(() => {
      schedule?.click();
    });
    expect(scheduleUpdateMock).toHaveBeenCalledTimes(1);
    expect(installUpdateMock).not.toHaveBeenCalled();
  });

  it('reflects a queued deferred install', () => {
    mockUpdateState({
      phase: 'downloaded',
      info: { version: '0.29.0' },
      installPending: true,
    });
    render(<UpdatePrompt />);

    const prompt = queryPrompt();
    expect(prompt?.tagName).toBe('BUTTON');
    expect(prompt?.textContent).toContain('Update queued');

    act(() => {
      prompt?.click();
    });
    expect(installUpdateMock).toHaveBeenCalledTimes(1);
  });

  it('offers a cancel action while a deferred install is queued', () => {
    mockUpdateState({
      phase: 'downloaded',
      info: { version: '0.29.0' },
      installPending: true,
    });
    render(<UpdatePrompt />);

    const cancel = container.querySelector<HTMLElement>(
      '[data-testid="update-prompt-cancel-schedule"]',
    );
    expect(cancel?.tagName).toBe('BUTTON');
    expect(cancel?.getAttribute('aria-label')).toBe(
      'Cancel the scheduled install of v0.29.0',
    );
    // The shared Tooltip owns the hover label; no native title attribute.
    expect(cancel?.hasAttribute('title')).toBe(false);

    act(() => {
      cancel?.click();
    });
    expect(cancelScheduledUpdateMock).toHaveBeenCalledTimes(1);
    expect(installUpdateMock).not.toHaveBeenCalled();
  });

  it('surfaces update errors with the message and a retry action', () => {
    mockUpdateState({
      phase: 'error',
      message: 'GitHub release request failed with HTTP 403.',
    });
    render(<UpdatePrompt />);

    const prompt = queryPrompt();
    expect(prompt?.tagName).toBe('BUTTON');
    expect(prompt?.textContent).toContain('Update failed');
    // fg-destructive label in light, fg-primary in dark, both on the neutral
    // elevated card.
    expect(prompt?.className).toContain('fg-primary');
    expect(prompt?.className).not.toContain('fg-destructive');
    expect(prompt?.className).toContain('bg-quaternary');
    // CAN-2799: the message is a rich hover tooltip, never a native title.
    expect(prompt?.hasAttribute('title')).toBe(false);
    act(() => {
      prompt?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'GitHub release request failed with HTTP 403.',
    );
    act(() => {
      prompt?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });

    act(() => {
      prompt?.click();
    });
    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
    expect(queryPrompt()?.textContent).toContain('Checking for updates…');
  });

  it('shows the error tooltip when the failure lands while the pointer rests on the banner', () => {
    // The Electron flow behind update-banner-states.spec.mjs: the user just
    // clicked the trailing schedule/cancel action, so the pointer is resting
    // on it when the updater reports an error and the split row is replaced
    // by the single error button. Chromium then dispatches no `mouseout` for
    // the removed action, and the new button's `mouseover` names the nearest
    // still-connected ancestor (the banner's React-rendered container div)
    // as `relatedTarget` — React's enter/leave plugin therefore never fires
    // `onMouseEnter`. Moving the pointer within the new button only produces
    // `mousemove`, and the tooltip must open.
    mockUpdateState({
      phase: 'downloaded',
      info: { version: '0.29.0' },
      installPending: true,
    });
    render(<UpdatePrompt />);
    const cancel = container.querySelector<HTMLElement>(
      '[data-testid="update-prompt-cancel-schedule"]',
    );
    if (!cancel) throw new Error('cancel action not found');
    act(() => {
      cancel.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Cancel scheduled install',
    );

    mockUpdateState({
      phase: 'error',
      message: 'GitHub release request failed with HTTP 403.',
    });
    act(() => {
      root.render(<UpdatePrompt />);
    });
    expect(cancel.isConnected).toBe(false);
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

    const prompt = queryPrompt();
    // The Tooltip wrapper span sits inside UpdatePrompt's container div.
    const host = prompt?.parentElement?.parentElement;
    if (!prompt || !(host instanceof HTMLDivElement)) {
      throw new Error('prompt or its container not found');
    }
    act(() => {
      prompt.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true, relatedTarget: host }),
      );
    });
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    act(() => {
      prompt.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'GitHub release request failed with HTTP 403.',
    );
  });

  it.each<UpdatePhase>(['idle', 'checking', 'not-available'])(
    'hides the prompt during the %s phase',
    (phase) => {
      mockUpdateState({ phase });
      render(<UpdatePrompt />);

      expect(queryPrompt()).toBeNull();
    },
  );

  it('no longer mounts the removed bottom-bar update status pill', () => {
    // The sidebar banner owns every update state now; the compact
    // bottom-status-bar pill was removed entirely.
    expect(APP_SIDEBAR_SOURCE).not.toContain('UpdateStatusPill');
    expect(APP_SIDEBAR_SOURCE).not.toContain('update-status-pill');
  });
});
