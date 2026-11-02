/** The code-graph hosts a launcher starts. */
export type CodeGraphHostKind = 'build' | 'read' | 'fingerprint';

/** Per-host memory limits, in MiB; see `ExecutionHostBudget`. */
export interface CodeGraphHostBudget {
  readonly heapMb: number;
  readonly rssMb: number;
}

/** Host facts the budget policy needs. */
export interface CodeGraphHostBudgetFacts {
  /** Physical memory of the machine running the host. */
  readonly totalMemoryBytes: number;
}

const MEBIBYTE = 1024 * 1024;

/**
 * The limits each host gets on a machine with enough memory. A forced full
 * build of the canopy repository (25,414 parsed files) peaked at 6,278 MiB of
 * heap and 8,411 MiB resident (CAN-5085). Peaks grow with the repository, so
 * the build limits leave about 40% headroom over that.
 */
export const CODE_GRAPH_HOST_BUDGETS: Readonly<
  Record<CodeGraphHostKind, CodeGraphHostBudget>
> = Object.freeze({
  build: Object.freeze({ heapMb: 10240, rssMb: 14336 }),
  read: Object.freeze({ heapMb: 2048, rssMb: 3072 }),
  fingerprint: Object.freeze({ heapMb: 512, rssMb: 1024 }),
});

/** No host may hold more than this share of the machine's memory. */
const MAX_MACHINE_SHARE = 0.75;

/**
 * The budget for one host. On a machine too small for the nominal resident
 * limit, the host gets a share of physical memory instead and the heap
 * limit shrinks to fit inside it, so a runaway host fails with a limit
 * outcome rather than pushing the machine into swap.
 */
export function codeGraphHostBudget(
  kind: CodeGraphHostKind,
  facts: CodeGraphHostBudgetFacts,
): CodeGraphHostBudget {
  const nominal = CODE_GRAPH_HOST_BUDGETS[kind];
  const machineMb = Math.floor(
    (facts.totalMemoryBytes * MAX_MACHINE_SHARE) / MEBIBYTE,
  );
  const rssMb = Math.max(1, Math.min(nominal.rssMb, machineMb));
  return { heapMb: Math.min(nominal.heapMb, rssMb), rssMb };
}
