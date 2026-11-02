import {
  createCoreScriptDefinitionHandlers,
  type CoreScriptDefinitionHandlers,
  type CoreScriptDefinitionsHost,
} from '@canopy/core-runtime/node/script/core-script-definitions';

// Loaded on the first script definition call, because the host modules import
// back into the runtime. Errors come only from host calls, so the loaded host
// classifies them.
let loadedHost: CoreScriptDefinitionsHost | undefined;
let loadingHost: Promise<CoreScriptDefinitionsHost> | undefined;
function loadHost(): Promise<CoreScriptDefinitionsHost> {
  loadingHost ??= import('../lib/script-definition-host').then((module) => {
    loadedHost = module.desktopScriptDefinitionsHost;
    return loadedHost;
  });
  return loadingHost;
}

export const desktopScriptDefinitionsHost: CoreScriptDefinitionsHost = {
  resolve: async (target) => (await loadHost()).resolve(target),
  readLocal: async (target) => (await loadHost()).readLocal(target),
  inspect: async (target, name) => (await loadHost()).inspect(target, name),
  change: async (input) => (await loadHost()).change(input),
  errorCode: (error) => loadedHost?.errorCode(error),
};

/** `core.script.definition.*` handlers over the desktop script sources. */
export function createCoreScriptDefinitionsAdapter(
  host: CoreScriptDefinitionsHost = desktopScriptDefinitionsHost,
): CoreScriptDefinitionHandlers {
  return createCoreScriptDefinitionHandlers(host);
}
