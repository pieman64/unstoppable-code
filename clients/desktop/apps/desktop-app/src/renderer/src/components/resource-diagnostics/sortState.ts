export type ResourceDiagnosticsSortColumn = 'name' | 'cpu' | 'memory';
export type ResourceDiagnosticsSortDirection = 'asc' | 'desc';

export interface ResourceDiagnosticsSortState {
  column: ResourceDiagnosticsSortColumn;
  direction: ResourceDiagnosticsSortDirection;
}

const DEFAULT_SORT: ResourceDiagnosticsSortState = {
  column: 'memory',
  direction: 'desc',
};

let stickySort: ResourceDiagnosticsSortState = { ...DEFAULT_SORT };

export function getResourceDiagnosticsSortState(): ResourceDiagnosticsSortState {
  return stickySort;
}

export function setResourceDiagnosticsSortState(
  next: ResourceDiagnosticsSortState,
): void {
  stickySort = next;
}

export function __resetResourceDiagnosticsSortForTests(): void {
  stickySort = { ...DEFAULT_SORT };
}
