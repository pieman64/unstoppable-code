import { TestEnvironment } from 'jest-environment-node';

// jest-environment-node keeps every global value a test replaced or deleted in
// its GlobalProxy `leftovers` until the whole file tears down. A suite that
// re-imports an entrypoint per test, which installs globals such as the
// `__CANOPY_E2E_*` seams, pins each test's module graph there. Drop those
// references once a test and its hooks finish so the graph can be collected.
export default class ReleasingNodeEnvironment extends TestEnvironment {
  private readonly leftovers: unknown[];

  constructor(...args: ConstructorParameters<typeof TestEnvironment>) {
    super(...args);
    const globalProxy: unknown = Reflect.get(this, '_globalProxy');
    const leftovers: unknown =
      typeof globalProxy === 'object' && globalProxy !== null
        ? Reflect.get(globalProxy, 'leftovers')
        : undefined;
    if (!Array.isArray(leftovers)) {
      throw new Error(
        'jest-environment-node no longer exposes GlobalProxy leftovers; update or remove jestReleasingNodeEnvironment.',
      );
    }
    this.leftovers = leftovers;
  }

  handleTestEvent(event: { name: string }): void {
    if (event.name !== 'test_done') return;
    // Jest would scrub these values' properties at teardown. Only drop the
    // references: a value still in use elsewhere must keep its properties.
    this.leftovers.length = 0;
  }
}
