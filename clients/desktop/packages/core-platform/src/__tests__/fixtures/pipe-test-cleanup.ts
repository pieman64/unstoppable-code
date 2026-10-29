interface PhasedReport {
  readonly phases: readonly { readonly id: number; readonly status: string }[];
}

/** Kernel shutdown resolves even when a phase fails or times out; only all-completed releases. */
export async function requireCompletedPhases(
  report: Promise<PhasedReport>,
): Promise<void> {
  const incomplete = (await report).phases.filter(
    ({ status }) => status !== 'completed',
  );
  if (incomplete.length)
    throw new Error(
      `Shutdown incomplete: ${incomplete.map(({ id, status }) => `phase ${id} ${status}`).join(', ')}`,
    );
}

/** One resource identity, including while an earlier observer has timed out. */
export class FixtureRelease {
  private completion: Promise<void> | undefined;
  private readonly prerequisites = new Set<FixtureRelease>();
  completed = false;
  failed = false;

  constructor(private readonly action: () => Promise<unknown>) {}

  dependsOn(...releases: FixtureRelease[]): void {
    if (this.completion) throw new Error('Release already started');
    for (const release of releases) this.prerequisites.add(release);
  }

  release(): Promise<void> {
    this.completion ??= Promise.resolve()
      .then(async () => {
        await Promise.all(
          [...this.prerequisites].map((release: FixtureRelease) =>
            release.release(),
          ),
        );
        await this.action();
        this.completed = true;
      })
      .catch((error: unknown) => {
        this.failed = true;
        this.completion = undefined;
        throw error;
      });
    return this.completion;
  }
}

/** Fixture lifetime; deadlines bound observation, never cancel or restart work. */
export class FixtureCleanup {
  private readonly releases: FixtureRelease[] = [];
  private closing = false;
  private initializing = 0;
  private disqualifyParent: (() => void) | undefined;
  private reportLateRelease: (() => void) | undefined;

  own(action: () => Promise<unknown>): FixtureRelease {
    const release = new FixtureRelease(action);
    this.releases.push(release);
    if (this.closing) {
      release.failed = true;
      // Let the registering caller attach dependencies in the same turn.
      void Promise.resolve()
        .then(() => release.release())
        .catch(() => undefined);
      this.disqualifyParent?.();
      this.reportLateRelease?.();
    }
    return release;
  }

  async acquire<T>(
    create: () => Promise<T>,
    dispose: (value: T) => Promise<unknown>,
    blocks: readonly FixtureRelease[] = [],
  ): Promise<{ value: T; release: FixtureRelease }> {
    if (this.closing) throw new Error('Fixture already closing');
    const acquired = Promise.withResolvers<T>();
    const release = this.own(async () => {
      // A rejected acquisition owns nothing; earlier acquisitions still unwind.
      const value = await acquired.promise.then(
        (value) => ({ value }),
        () => undefined,
      );
      if (value) await dispose(value.value);
    });
    try {
      for (const blocked of blocks) blocked.dependsOn(release);
    } catch (error) {
      acquired.reject(error);
      await release.release();
      throw error;
    }
    void Promise.resolve().then(create).then(acquired.resolve, acquired.reject);
    const value = await acquired.promise;
    if (this.closing) throw new Error('Fixture closed during acquisition');
    return { value, release };
  }

  fork(blocks: readonly FixtureRelease[] = []): FixtureCleanup {
    if (this.closing) throw new Error('Fixture already closing');
    const scope = new FixtureCleanup();
    const release = this.own(async () => {
      scope.closing = true;
      // Only observers have deadlines; this dependency must keep tracking completion.
      await scope.drain();
      const failures = scope.releases.filter((owned) => owned.failed).length;
      if (failures) release.failed = true;
      if (scope.releases.some((owned) => !owned.completed))
        throw new Error(`Fixture teardown incomplete (${failures})`);
    });
    scope.disqualifyParent = (): void => {
      release.failed = true;
      this.disqualifyParent?.();
      this.reportLateRelease?.();
    };
    for (const blocked of blocks) blocked.dependsOn(release);
    return scope;
  }

  async initialize<T>(create: () => Promise<T>): Promise<T> {
    if (this.closing) throw new Error('Fixture already closing');
    this.initializing += 1;
    const initialized = Promise.withResolvers<void>();
    this.own(() => initialized.promise);
    try {
      let value: T;
      try {
        value = await create();
      } finally {
        this.initializing -= 1;
        initialized.resolve();
      }
      if (this.closing) throw new Error('Fixture closed during initialization');
      return value;
    } catch (error) {
      this.closing = true;
      // An inner constructor must reject before its outer barrier can settle.
      if (this.initializing) void this.drain();
      else await this.close();
      throw error;
    }
  }

  async close(
    budgetMs = 15_000,
    report?: (failures: number) => void,
  ): Promise<number> {
    this.closing = true;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.drain(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, budgetMs));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    for (const release of this.releases)
      if (!release.completed) release.failed = true;
    const failures = (): number =>
      this.releases.filter((release) => release.failed).length;
    // Keep serialized evidence disqualified without awaiting late work or another close.
    if (report) this.reportLateRelease = (): void => report(failures());
    const count = failures();
    report?.(count);
    return count;
  }

  private async drain(): Promise<void> {
    let observed = 0;
    do {
      const pending = this.releases.slice(observed);
      observed = this.releases.length;
      await Promise.allSettled(pending.map((release) => release.release()));
    } while (observed !== this.releases.length);
  }
}

const callbackReleases = new WeakMap<() => Promise<unknown>, FixtureRelease>();

/** Legacy callback adapter; fixture close paths must share owned handles instead. */
export async function releaseAll(
  actions: (() => Promise<unknown>)[],
  budgetMs = 15_000,
): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let failures = 0;
  // Preserve dependency order while reserving time for every independent release.
  const pending = [...actions].reverse();
  const retry: (() => Promise<unknown>)[] = [];
  let remaining = pending.length;
  for (const action of pending) {
    let release = callbackReleases.get(action);
    if (!release) {
      release = new FixtureRelease(action);
      callbackReleases.set(action, release);
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        release.release(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('teardown deadline')),
            Math.max(1, Math.floor((deadline - Date.now()) / remaining)),
          );
        }),
      ]);
    } catch {
      failures += 1;
      retry.push(action);
    } finally {
      clearTimeout(timer);
      remaining -= 1;
    }
  }
  actions.splice(0, pending.length, ...retry.reverse());
  return failures;
}
