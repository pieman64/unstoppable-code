import {
  INTERFACE_RELAY_ALLOWLIST,
  type InterfaceRelayAccessMode,
  type InterfaceRelayOperationKind,
} from './interface-allowlist.generated';

export type RendererRelaySurface = 'main' | 'app-advisor';
export const RENDERER_RELAY_SURFACES: readonly RendererRelaySurface[] = [
  'main',
  'app-advisor',
];

// Connection setup, lease ownership and host stores stay with the relay's
// host, never a renderer.
const ADMIN_METHODS: ReadonlySet<string> = new Set([
  'core.runtime.initialize',
  'worker.runtime.initialize',
]);
const ADMIN_PREFIXES: readonly string[] = [
  'core.client.lease.',
  // The trusted W5 record port is Electron main's own store (W6g, CAN-5498).
  'core.workspaceRecords.',
];

function isAdminMethod(method: string): boolean {
  return (
    ADMIN_METHODS.has(method) ||
    ADMIN_PREFIXES.some((prefix) => method.startsWith(prefix))
  );
}

// Narrowing per surface; `null` keeps the full generated interface set.
const SURFACE_NARROWING: Readonly<
  Record<
    RendererRelaySurface,
    Readonly<Record<InterfaceRelayOperationKind, readonly string[]>> | null
  >
> = {
  main: null,
  'app-advisor': {
    query: ['core.runtime.health.get'],
    instruction: [
      'core.client.capabilities.register',
      'core.client.tools.register',
      'core.client.tools.unregister',
    ],
    stream: ['core.runtime.events'],
  },
};

/** Whether `surface` may call `method` as `kind` in `mode`: generated set, minus admin, narrowed per surface. */
export function relayAllows(
  surface: RendererRelaySurface,
  kind: InterfaceRelayOperationKind,
  method: string,
  mode: InterfaceRelayAccessMode = 'authority',
): boolean {
  if (isAdminMethod(method)) return false;
  if (!INTERFACE_RELAY_ALLOWLIST[mode][kind].includes(method)) return false;
  const narrowed = SURFACE_NARROWING[surface];
  return narrowed === null || narrowed[kind].includes(method);
}
