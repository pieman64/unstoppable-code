import inventory from '../../../../../scripts/lib/windows-pipe-inventory.json';

type Case = (typeof inventory.cases)[number];

/** Check every kit registration, including named exclusions, before invoking Jest. */
export function pipeConformanceRegistration(
  registerDescribe: (title: string, body: () => void) => void,
  registerTest: (title: string, body: () => Promise<void>) => void,
): {
  describe(title: string, body: () => void): void;
  it(title: string, body: () => Promise<void>): void;
  todo(title: string): void;
  complete(): void;
} {
  const ancestors: string[] = [];
  const seen = new Set<string>();
  const required = new Set<string>();
  const excluded = new Set<string>();
  const suites: {
    title: string;
    tests: { title: string; body: () => Promise<void> }[];
  }[] = [];
  let current: (typeof suites)[number] | undefined;
  let completed = false;
  let failure: Error | undefined;
  const reject = (message: string): never => {
    failure = new Error(message);
    throw failure;
  };
  const requireCollecting = (): void => {
    if (completed)
      throw new Error('Duplicate pipe registration: already completed');
    if (failure) throw failure;
  };
  const accept = (title: string, kind: string): Case | undefined => {
    requireCollecting();
    const key = JSON.stringify([...ancestors, title]);
    if (seen.has(key)) reject(`Duplicate pipe registration: ${key}`);
    seen.add(key);
    const entry = inventory.cases.find(
      (item) =>
        item.layer !== 'native' &&
        item.title === title &&
        JSON.stringify(item.ancestorTitles) === JSON.stringify(ancestors),
    );
    if (entry && kind === 'case') {
      if (required.has(entry.id)) reject(`Duplicate pipe id: ${entry.id}`);
      required.add(entry.id);
      return entry;
    }
    const exclusion = inventory.exclusions.find(
      (item) => item.title === title && item.kind === kind,
    );
    if (
      ancestors.length === 1 &&
      ancestors[0] === 'Canopy transport conformance: secured-pipe' &&
      exclusion
    ) {
      excluded.add(exclusion.id);
      return undefined;
    }
    return reject(`Unknown pipe registration: ${key}`);
  };
  return {
    describe(title, body): void {
      requireCollecting();
      const parent = current;
      current = { title, tests: [] };
      suites.push(current);
      ancestors.push(title);
      try {
        body();
      } finally {
        ancestors.pop();
        current = parent;
      }
    },
    it(title, body): void {
      if (accept(title, 'case')) {
        if (!current) throw new Error('Pipe case outside a suite');
        current.tests.push({ title, body });
      }
    },
    todo(title): void {
      accept(title, 'todo');
    },
    complete(): void {
      requireCollecting();
      const wanted = inventory.cases.filter((item) => item.layer !== 'native');
      if (
        wanted.some((item) => !required.has(item.id)) ||
        required.size !== 20 ||
        inventory.exclusions.some((item) => !excluded.has(item.id))
      )
        throw new Error('Incomplete secured-pipe kit registration');
      completed = true;
      for (const suite of suites)
        registerDescribe(suite.title, () => {
          for (const test of suite.tests) registerTest(test.title, test.body);
        });
    },
  };
}
