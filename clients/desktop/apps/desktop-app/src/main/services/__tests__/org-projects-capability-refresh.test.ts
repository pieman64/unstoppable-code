import { installOrgProjectsCapabilityRefresh } from '../org-projects-capability-refresh';

interface FakeFlags {
  enabled: boolean;
  emit(): void;
  isEnabled(): boolean;
  onSnapshotChanged(listener: () => void): () => void;
}

function fakeFlags(initial: boolean): FakeFlags {
  const listeners = new Set<() => void>();
  return {
    enabled: initial,
    emit(): void {
      listeners.forEach((listener) => listener());
    },
    isEnabled(): boolean {
      return this.enabled;
    },
    onSnapshotChanged(listener: () => void): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  };
}

describe('installOrgProjectsCapabilityRefresh', () => {
  it('refreshes the account as soon as organization projects turn on', () => {
    const flags = fakeFlags(false);
    const refresh = jest.fn(() => Promise.resolve());
    installOrgProjectsCapabilityRefresh({ flags, refresh });

    flags.enabled = true;
    flags.emit();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes again when organization projects turn back off', () => {
    const flags = fakeFlags(true);
    const refresh = jest.fn(() => Promise.resolve());
    installOrgProjectsCapabilityRefresh({ flags, refresh });

    flags.enabled = false;
    flags.emit();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('ignores snapshots that leave organization projects unchanged', () => {
    const flags = fakeFlags(true);
    const refresh = jest.fn(() => Promise.resolve());
    installOrgProjectsCapabilityRefresh({ flags, refresh });

    flags.emit();
    flags.emit();

    expect(refresh).not.toHaveBeenCalled();
  });

  it('contains a failed refresh and keeps listening', async () => {
    const flags = fakeFlags(false);
    const refresh = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    installOrgProjectsCapabilityRefresh({ flags, refresh });

    flags.enabled = true;
    flags.emit();
    await Promise.resolve();
    flags.enabled = false;
    flags.emit();

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('stops refreshing once disposed', () => {
    const flags = fakeFlags(false);
    const refresh = jest.fn(() => Promise.resolve());
    const dispose = installOrgProjectsCapabilityRefresh({ flags, refresh });

    dispose();
    flags.enabled = true;
    flags.emit();

    expect(refresh).not.toHaveBeenCalled();
  });
});
