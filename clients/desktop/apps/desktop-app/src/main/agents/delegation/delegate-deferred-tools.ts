import type {
  ChatInterfaceMode,
  ChatTabPluginSelections,
  DeferredToolsReloadScopeKey,
} from '@canopy/desktop-shared/types';
import type {
  DeferredToolsExecutorRuntime,
  DeferredToolsReloadSink,
} from '../../deferred-tools/executor';

export interface DelegateCapabilityDiscoveryGateOptions {
  readonly rootDeferredToolsAllowed: () => boolean | undefined;
  readonly grantDiscovery: () => boolean;
}

export interface DelegateDeferredToolsSourceOptions extends DelegateCapabilityDiscoveryGateOptions {
  readonly scope: DeferredToolsReloadScopeKey;
  readonly providerType: 'claude' | 'codex';
  readonly interfaceMode?: ChatInterfaceMode;
  /** The child's effective selection, read live for every tool call. */
  readonly pluginSelections: () => ChatTabPluginSelections;
  readonly reload: DeferredToolsReloadSink;
}

export interface DelegateDeferredToolsSource {
  allowed(): boolean;
  runtime(): DeferredToolsExecutorRuntime;
}

export function delegateCapabilityDiscoveryAllowed(
  options: DelegateCapabilityDiscoveryGateOptions,
): boolean {
  return (
    options.rootDeferredToolsAllowed() === true && options.grantDiscovery()
  );
}

export function createDelegateDeferredToolsSource(
  options: DelegateDeferredToolsSourceOptions,
): DelegateDeferredToolsSource {
  const allowed = (): boolean =>
    delegateCapabilityDiscoveryAllowed({
      rootDeferredToolsAllowed: options.rootDeferredToolsAllowed,
      grantDiscovery: options.grantDiscovery,
    });

  const runtime = (): DeferredToolsExecutorRuntime => ({
    scope: options.scope,
    providerType: options.providerType,
    ...(options.interfaceMode !== undefined
      ? { interfaceMode: options.interfaceMode }
      : {}),
    pluginSelections: options.pluginSelections(),
    allowed: allowed(),
    reloadSink: options.reload,
  });

  return { allowed, runtime };
}
