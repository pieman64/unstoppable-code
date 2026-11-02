import { mkdir } from 'node:fs/promises';
import { getDefaultReposDir } from './paths';
import { readPreferencesFile } from './preferences-store';

/** Host-local default, shared by creation and paired catalog Add. */
export async function resolveOrgProjectSetupDestination(): Promise<string> {
  const preferences = await readPreferencesFile();
  if (preferences.orgProjectDefaultDestinationRoot)
    return preferences.orgProjectDefaultDestinationRoot;
  // The ordinary clone folder is independent of all selected source checkouts.
  // The materializer validates it and allocates its own fresh child destination.
  const root = getDefaultReposDir();
  await mkdir(root, { recursive: true });
  return root;
}
