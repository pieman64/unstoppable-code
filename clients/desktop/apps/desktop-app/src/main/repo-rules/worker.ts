import type { EditorSetupPresence } from '@canopy/protocol/repo-rules';
import {
  discoverRules,
  readSessionRules,
  type RepoCheckout,
  type RulesRead,
} from './discovery';
import { editorSetupPresence } from './presence';

/** Worker owns checkout access; core supplies authorized roots and policy. */
export interface RepoRulesWorkerPort {
  scan(repos: RepoCheckout[]): Promise<RulesRead>;
  readSession(
    repos: RepoCheckout[],
    nestedDirectories: Record<string, string[]>,
  ): Promise<RulesRead>;
  presence(repos: RepoCheckout[]): Promise<EditorSetupPresence>;
}

/** Same-process binding. No transport, writer, or execution authority moves. */
export const repoRulesWorker: RepoRulesWorkerPort = {
  scan: discoverRules,
  readSession: readSessionRules,
  presence: editorSetupPresence,
};
