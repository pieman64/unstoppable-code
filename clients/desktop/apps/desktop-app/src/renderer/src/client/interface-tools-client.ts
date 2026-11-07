import {
  CORE_CLIENT_TOOLS_REGISTER,
  CORE_CLIENT_TOOLS_UNREGISTER,
  interfaceToolDescriptor,
  type InterfaceToolName,
} from '@canopy/protocol/canopy-core';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';

async function invoke(
  method: string,
  params: Record<string, unknown>,
  warnOnFailure: boolean,
): Promise<void> {
  if (typeof window === 'undefined' || !window.canopyCore) return;
  try {
    const reply = await window.canopyCore.invoke({
      kind: 'request',
      method,
      params,
    });
    if (!reply.ok && warnOnFailure)
      // eslint-disable-next-line no-console
      console.warn('[interface-tools] registration failed', reply.error.kind);
  } catch {
    // The tools are then simply absent.
    reportClientAppError(new Error('Interface tool registration failed'));
  }
}

/** Registers the catalog tools this page implements on its own lease. Failures are logged and ignored: the tools are then simply absent. */
export async function registerInterfaceTools(
  names: readonly InterfaceToolName[],
  idempotencyKey: string,
): Promise<void> {
  await invoke(
    CORE_CLIENT_TOOLS_REGISTER,
    {
      tools: names.map(interfaceToolDescriptor),
      _meta: { idempotencyKey },
    },
    true,
  );
}

/** Removes every tool this page registered. Failures are ignored. */
export async function unregisterAllInterfaceTools(): Promise<void> {
  await invoke(CORE_CLIENT_TOOLS_UNREGISTER, { all: true }, false);
}
