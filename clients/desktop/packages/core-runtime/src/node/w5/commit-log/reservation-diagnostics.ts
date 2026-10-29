/*
 * The one validator for live workspace-creation reservation diagnostics,
 * decoded by hand so the commit log needs no schema library. It accepts and
 * refuses what the zod schema it replaced (CAN-4408) did, with output keys in
 * shape order, unknown top-level keys stripped, strict repository entries and
 * the same bounds, so accepted values serialize to the same stored bytes.
 * One in-memory difference: an optional key given as undefined is omitted,
 * where zod kept it as undefined; JSON drops it either way.
 */

const MAX_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;
const MAX_ITEMS = 1024;

const ROLES = ['source', 'member'] as const;
const STATUSES = ['started', 'completed'] as const;
const ACTIONS = ['clone', 'initialize', 'import'] as const;
const PHASES = [
  'before-canonical-commit',
  'source-initialization',
  'remote-clone',
  'member-import',
] as const;

const REPOSITORY_KEYS = ['id', 'role', 'status', 'action', 'owned'];
const UNOWNED_KEYS: ReadonlySet<string> = new Set(REPOSITORY_KEYS);
const OWNED_KEYS: ReadonlySet<string> = new Set(REPOSITORY_KEYS.concat('path'));

interface WorkspaceCreationRepositoryStep {
  id: string;
  role: (typeof ROLES)[number];
  status: (typeof STATUSES)[number];
  action?: (typeof ACTIONS)[number] | undefined;
}

/** Only owned artifacts have paths; imported user repositories are never claimed. */
export type WorkspaceCreationRepository =
  | (WorkspaceCreationRepositoryStep & { owned: true; path: string })
  | (WorkspaceCreationRepositoryStep & { owned: false });

export interface WorkspaceCreationDiagnostics {
  kind: 'local-workspace-create';
  workspaceId: string;
  ownedPaths: string[];
  phase: (typeof PHASES)[number];
  repositories?: WorkspaceCreationRepository[] | undefined;
}

export type W5DecodeResult<T> =
  | { success: true; data: T }
  | { success: false; error: W5DiagnosticsDecodeError };

export interface W5Decoder<T> {
  safeParse(value: unknown): W5DecodeResult<T>;
  /** Throws {@link W5DiagnosticsDecodeError} for an invalid value. */
  parse(value: unknown): T;
}

/** Names only the first invalid field, never its value. */
export class W5DiagnosticsDecodeError extends Error {
  constructor(readonly path: string) {
    super(
      `Invalid workspace creation diagnostics at ${path === '' ? 'the top level' : path}.`,
    );
    this.name = 'W5DiagnosticsDecodeError';
  }
}

function fail(path: string): never {
  throw new W5DiagnosticsDecodeError(path);
}

function at(path: string, key: string | number): string {
  return path === '' ? String(key) : `${path}.${String(key)}`;
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(
  value: unknown,
  path: string,
  minLength: number,
  maxLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length < minLength ||
    value.length > maxLength
  ) {
    return fail(path);
  }
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T {
  const match = values.find((candidate) => candidate === value);
  return match === undefined ? fail(path) : match;
}

function list<T>(
  value: unknown,
  path: string,
  decodeItem: (item: unknown, path: string) => T,
): T[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return fail(path);
  const items: readonly unknown[] = value;
  const decoded: T[] = [];
  // Indexed, so a hole is read as undefined and refused like any bad item.
  for (let index = 0; index < items.length; index += 1) {
    decoded.push(decodeItem(items[index], at(path, index)));
  }
  return decoded;
}

function decodeRepository(
  value: unknown,
  path: string,
): WorkspaceCreationRepository {
  if (!isObject(value)) return fail(path);
  const owned: unknown = Reflect.get(value, 'owned');
  if (owned !== true && owned !== false) return fail(at(path, 'owned'));
  const allowedKeys = owned ? OWNED_KEYS : UNOWNED_KEYS;
  // for...in, as the replaced schema's strict check enumerated keys.
  for (const key in value) {
    if (!allowedKeys.has(key)) return fail(path);
  }
  const action: unknown = Reflect.get(value, 'action');
  const step: WorkspaceCreationRepositoryStep = {
    id: text(Reflect.get(value, 'id'), at(path, 'id'), 1, MAX_ID_LENGTH),
    role: oneOf(Reflect.get(value, 'role'), ROLES, at(path, 'role')),
    status: oneOf(Reflect.get(value, 'status'), STATUSES, at(path, 'status')),
    ...(action === undefined
      ? {}
      : { action: oneOf(action, ACTIONS, at(path, 'action')) }),
  };
  return owned
    ? {
        ...step,
        owned: true,
        path: text(
          Reflect.get(value, 'path'),
          at(path, 'path'),
          0,
          MAX_PATH_LENGTH,
        ),
      }
    : { ...step, owned: false };
}

function decodeDiagnostics(value: unknown): WorkspaceCreationDiagnostics {
  if (!isObject(value)) return fail('');
  const kind: unknown = Reflect.get(value, 'kind');
  if (kind !== 'local-workspace-create') return fail('kind');
  const repositories: unknown = Reflect.get(value, 'repositories');
  return {
    kind,
    workspaceId: text(
      Reflect.get(value, 'workspaceId'),
      'workspaceId',
      1,
      MAX_ID_LENGTH,
    ),
    ownedPaths: list(
      Reflect.get(value, 'ownedPaths'),
      'ownedPaths',
      (item, path) => text(item, path, 0, MAX_PATH_LENGTH),
    ),
    phase: oneOf(Reflect.get(value, 'phase'), PHASES, 'phase'),
    ...(repositories === undefined
      ? {}
      : {
          repositories: list(repositories, 'repositories', decodeRepository),
        }),
  };
}

function decoder<T>(decode: (value: unknown, path: string) => T): W5Decoder<T> {
  return {
    safeParse(value: unknown): W5DecodeResult<T> {
      try {
        return { success: true, data: decode(value, '') };
      } catch (error) {
        if (error instanceof W5DiagnosticsDecodeError) {
          return { success: false, error };
        }
        throw error;
      }
    },
    parse(value: unknown): T {
      return decode(value, '');
    },
  };
}

export const workspaceCreationRepositorySchema: W5Decoder<WorkspaceCreationRepository> =
  decoder(decodeRepository);

/** Shared by reservation updates and the host's launch diagnostics projection. */
export const workspaceCreationDiagnosticsSchema: W5Decoder<WorkspaceCreationDiagnostics> =
  decoder(decodeDiagnostics);

export const W5_RESERVATION_DIAGNOSTICS_MAX_BYTES = 64 * 1024;
