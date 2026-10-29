import { lazy, Suspense, useEffect, type JSX } from 'react';
import { useNavigationStore } from '@/stores/navigationStore';
import { isOnboardingSuggestionsModuleEnabled } from './completionWriter';
import { useHomeOnboardingSuggestionsState } from './useOnboardingSuggestions';
import { useOnboardingSuggestionSurfaces } from '@/stores/onboardingSuggestionSurfacesStore';

const Suggestions = lazy(() =>
  import('./HomeOnboardingSuggestions').then((module) => ({
    default: module.HomeOnboardingSuggestions,
  })),
);

/** One gated owner for provider probes, progress and actions across navigation. */
export function OnboardingSuggestionsRuntime(): JSX.Element | null {
  // Every install runs the module; only the E2E harness can hold it back so
  // unrelated automation sees the settled Home and sidebar.
  const state = useHomeOnboardingSuggestionsState(
    isOnboardingSuggestionsModuleEnabled(),
  );
  const home = useOnboardingSuggestionSurfaces((s) => s.home);
  const chat = useOnboardingSuggestionSurfaces((s) => s.chat);
  const sidebar = useOnboardingSuggestionSurfaces((s) => s.sidebar);
  useEffect(() => {
    useOnboardingSuggestionSurfaces.setState({ visible: state.visible });
    return (): void =>
      useOnboardingSuggestionSurfaces.setState({ visible: false });
  }, [state.visible]);
  return (
    <Suspense fallback={null}>
      {state.visible && state.persisted ? (
        <Suggestions
          persisted={state.persisted}
          selectedRoles={state.selectedRoles}
          onChangeRoles={state.changeRoles}
          onUpdatePersisted={state.update}
          onInjectPrompt={useNavigationStore.getState().requestHomeComposerText}
          homeHost={home}
          chatHost={chat}
          sidebarHost={sidebar}
        />
      ) : null}
    </Suspense>
  );
}
