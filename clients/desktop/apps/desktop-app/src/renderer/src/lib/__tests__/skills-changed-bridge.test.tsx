/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import { useSkillList } from '@/hooks/useSkillList';
import {
  bridgeMainSkillsChanged,
  notifySkillsChanged,
  useSkillsChangedRefresh,
} from '../skillsChanged';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function skill(name: string): InstalledSkillInfo {
  return {
    name,
    description: `${name} skill`,
    sourceId: 'custom',
    source: 'custom',
    installedAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z',
    updateAvailable: false,
    custom: true,
  };
}

let installed: InstalledSkillInfo[] = [];
const loadSkills = jest.fn(() =>
  Promise.resolve({ success: true, data: [...installed] }),
);
let mainListeners: (() => void)[] = [];
const onChanged = (listener: () => void): (() => void) => {
  mainListeners.push(listener);
  return () => {
    mainListeners = mainListeners.filter((entry) => entry !== listener);
  };
};

/** The Plugins page's Discovery inventory: its own skill list, refreshed on the event. */
function DiscoveryInventory(): JSX.Element {
  const { skills, refreshOrThrow } = useSkillList();
  useSkillsChangedRefresh(refreshOrThrow);
  return (
    <ul>
      {skills.map((entry) => (
        <li key={entry.name}>{entry.name}</li>
      ))}
    </ul>
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('main skills-changed bridge (CAN-5860)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    installed = [skill('alpha')];
    loadSkills.mockClear();
    mainListeners = [];
    Object.defineProperty(window, 'skills', {
      configurable: true,
      value: { loadSkills, onChanged },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('a main skills notice refreshes every skills-changed listener and tracks the refresh', async () => {
    const stop = bridgeMainSkillsChanged(onChanged);
    act(() => root.render(<DiscoveryInventory />));
    await flush();
    expect(container.textContent).toBe('alpha');

    installed = [skill('alpha'), skill('beta')];
    const other = jest.fn();
    window.addEventListener('canopy:skills-changed', other);
    act(() => {
      for (const listener of mainListeners) listener();
    });
    await flush();

    expect(container.textContent).toBe('alphabeta');
    expect(other).toHaveBeenCalledTimes(1);
    expect(loadSkills).toHaveBeenCalledTimes(2);
    window.removeEventListener('canopy:skills-changed', other);

    let finished = false;
    let release = (): void => undefined;
    loadSkills.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = (): void =>
            resolve({ success: true, data: [...installed] });
        }),
    );
    let announced: Promise<void> = Promise.resolve();
    act(() => {
      announced = notifySkillsChanged().then(() => {
        finished = true;
      });
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    await act(async () => {
      release();
      await announced;
    });
    expect(finished).toBe(true);
    stop();
  });

  it('the bridge stops after unsubscribe', () => {
    const listener = jest.fn();
    window.addEventListener('canopy:skills-changed', listener);
    const stop = bridgeMainSkillsChanged(onChanged);
    expect(mainListeners).toHaveLength(1);
    stop();
    expect(mainListeners).toHaveLength(0);
    window.removeEventListener('canopy:skills-changed', listener);
    expect(listener).not.toHaveBeenCalled();
  });
});
