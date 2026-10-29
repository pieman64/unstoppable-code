import { useAutomationScope } from '@/hooks/useAutomationScope';
import { toInstallWorkspaceOptions } from '@/lib/installWorkspaceOptions';

/** The projects an automation install can target in the selected context. */
export function useInstallWorkspaces(): ReturnType<
  typeof toInstallWorkspaceOptions
> {
  const scope = useAutomationScope();
  return toInstallWorkspaceOptions(scope.projectsInContext);
}
