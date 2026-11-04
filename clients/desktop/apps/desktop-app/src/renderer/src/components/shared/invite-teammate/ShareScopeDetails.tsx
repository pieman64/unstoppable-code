import type { JSX } from 'react';
import type { SharedContainerSharePreview } from '@canopy/desktop-shared/types';
import type { SharedContainerType } from '@canopy/protocol/shared-containers';
import { CHAT_LABEL } from '@canopy/protocol';
import { getScriptDisplayName } from '@canopy/desktop-shared/scripts';
import { ChoiceField, Disclosure } from '@canopy/ui-shared/components';
import { formatCapabilityPackageShareNote } from '@canopy/ui-shared/sharing';
import { brandText } from '@/lib/brand';
import {
  ADVANCED_LABEL,
  containerNoun,
  snapshotRepositoryDisclosure,
} from './shareCopy';
import {
  MAX_PUBLISHABLE_RUN_SCRIPTS,
  type CandidateDirectoryGroup,
} from './useSharePreview';

export interface ShareScopeDetailsProps {
  preview: SharedContainerSharePreview;
  containerType: SharedContainerType;
  /** The "what is shared" sentence that opens the expanded body. */
  summary: string;
  /** Repositories whose code travels through the cloud, not GitHub. */
  snapshotRepositoryCount: number;
  snapshotRepositoryNames: string[];
  /** Files the owner explicitly left out of an opt-out share. */
  approvedExcludedPaths: string[] | undefined;
  /** The files this share carries, after exclusions and the budget cap. */
  includedFilePaths: string[];
  /** Whether ticking a file adds it, rather than keeping one already in. */
  fileScopeIsAllowlist: boolean;
  includedNoteIds: string[];
  includedPromptIds: string[];
  candidateDirectories: CandidateDirectoryGroup[];
  selectableFilePaths: string[];
  withheldFileCount: number;
  withheldFilePaths: string[];
  withheldSymlinkPaths: string[];
  /** Whether the run affordance may be offered at all (flag + macOS). */
  runSharingSupported: boolean;
  runSharingEnabled: boolean;
  includedRunScripts: string[];
  /** Every script the publisher may tick, from their own resolved scripts. */
  availableRunScripts: string[];
  fileScopeSaving: boolean;
  onFileScopeChange: (path: string, included: boolean) => void;
  onDirectoryScopeChange: (paths: readonly string[], included: boolean) => void;
  onNoteScopeChange: (noteId: string, included: boolean) => void;
  onPromptScopeChange: (promptId: string, included: boolean) => void;
  onRunSharingChange: (enabled: boolean) => void;
  onRunScriptScopeChange: (scriptName: string, included: boolean) => void;
}

/**
 * The collapsed "Advanced" expander holding everything the owner *may* want to
 * read or opt out of, and nothing they *must*.
 *
 * The boundary is deliberate and load-bearing: anything that prevents
 * publishing (the artifact-budget refusal, an undisclosable repository, any
 * refusal that disables Invite) stays outside this component, always visible.
 * Only informational content collapses. Hiding a blocker behind a disclosure
 * would let an owner click Invite believing the share will publish.
 *
 * Everything is shared by default: files not in git (or a Cowork folder's
 * files), notes, prompts, and a worktree's first eight run scripts. Unticking
 * is a filter rather than a publish gate, and saving the scope still triggers
 * an explicit publish. Only a Cowork scope narrowed under the old allowlist
 * semantics still reads its ticks as additions.
 */
export function ShareScopeDetails({
  preview,
  containerType,
  summary,
  snapshotRepositoryCount,
  snapshotRepositoryNames,
  approvedExcludedPaths,
  includedFilePaths,
  fileScopeIsAllowlist,
  includedNoteIds,
  includedPromptIds,
  candidateDirectories,
  selectableFilePaths,
  withheldFileCount,
  withheldFilePaths,
  withheldSymlinkPaths,
  runSharingSupported,
  runSharingEnabled,
  includedRunScripts,
  availableRunScripts,
  fileScopeSaving,
  onFileScopeChange,
  onDirectoryScopeChange,
  onNoteScopeChange,
  onPromptScopeChange,
  onRunSharingChange,
  onRunScriptScopeChange,
}: ShareScopeDetailsProps): JSX.Element {
  const isCoworkContainer = containerType === 'COWORK_WORK_ENTRY';
  const noun = containerNoun();
  const snapshotDisclosure = snapshotRepositoryDisclosure(
    snapshotRepositoryCount,
    snapshotRepositoryNames,
  );
  const capabilityNote = preview.capabilityPackageCounts
    ? formatCapabilityPackageShareNote(preview.capabilityPackageCounts)
    : null;
  const includedFileSet = new Set(includedFilePaths);
  const approvedExcludedFileSet = new Set(approvedExcludedPaths ?? []);
  const budgetCappedFileSet = new Set(
    fileScopeIsAllowlist
      ? []
      : selectableFilePaths.filter(
          (path) =>
            !includedFileSet.has(path) && !approvedExcludedFileSet.has(path),
        ),
  );

  return (
    <Disclosure
      label={ADVANCED_LABEL}
      dataTestId="shared-container-invite-modal-scope-details"
    >
      <p
        className="text-xs fg-primary"
        data-testid="shared-container-invite-modal-scope-summary"
      >
        {summary}
      </p>
      {/*
        Disclosure. Both container types have a revision producer, so the
        copy states what actually leaves this machine. A code worktree also
        discloses its base commit, because the recipient reconstructs the
        tree by cloning that commit and applying the approved changes on
        top of it.
      */}
      <p
        className="text-xs fg-secondary"
        data-testid="shared-container-invite-modal-disclosure"
      >
        {isCoworkContainer
          ? `Your teammate is granted access to this ${noun} and sees it in their shared list right away. ${brandText.appName} publishes an encrypted, read-only copy shortly after you invite them, and again as you keep working. That copy carries this folder's files, apart from any you untick below.`
          : `Your teammate is granted access to this ${noun} and sees it in their shared list right away. ${brandText.appName} publishes an encrypted, read-only copy shortly after you invite them, and again as you keep working. That copy is the pushed commit your branch is based on, plus your uncommitted changes and files not in git, apart from any you untick below.`}
      </p>
      {/*
        Informational, never a gate: where the code of a repository with no
        GitHub remote goes.
      */}
      {snapshotDisclosure && (
        <p
          className="text-xs fg-secondary"
          data-testid="shared-container-invite-modal-snapshot-disclosure"
        >
          {snapshotDisclosure}
        </p>
      )}

      <ul className="list-disc space-y-0.5 pl-4 text-xs fg-secondary">
        {preview.repositories && preview.repositories.length > 1
          ? preview.repositories.map((repository) => (
              <li
                key={repository.repoId}
              >{`${repository.repoName}: ${repository.remoteUrl} at ${repository.baseCommitSha.slice(0, 7)}`}</li>
            ))
          : preview.repository && (
              <li>{`Repository ${preview.repository.remoteUrl} at ${preview.repository.baseCommitSha.slice(0, 7)}`}</li>
            )}
      </ul>

      {/*
        Capabilities used here are bundled automatically; there is nothing to
        choose. Absent while analysis is cold or the package would be empty.
      */}
      {capabilityNote !== null && (
        <p
          className="text-xs fg-secondary"
          data-testid="shared-container-invite-modal-capabilities"
        >
          {capabilityNote}
        </p>
      )}

      {/*
        Withholding is Canopy working correctly - automatic suppression of
        credential-shaped, oversized, hard-linked, or repo-escaping files.
        It is informational, so it renders in `fg-secondary`. Rendering it
        as a destructive warning taught owners to read a healthy share as a
        broken one.
      */}
      {withheldFileCount > 0 && (
        <p
          className="text-xs fg-secondary"
          role="status"
          data-testid="shared-container-invite-modal-withheld-files"
        >
          {isCoworkContainer
            ? `${withheldFileCount} ${withheldFileCount === 1 ? 'file' : 'files'} will be withheld from this share. ${brandText.appName} holds back files that look like credentials, exceed the sharing size limit, or sit in a build or dependency folder.`
            : `${withheldFileCount} changed ${withheldFileCount === 1 ? 'file' : 'files'} will be withheld from this share. ${brandText.appName} holds back files that look like credentials, exceed the sharing size limit, or link outside the repository.`}
        </p>
      )}
      {withheldFilePaths.length > 0 && (
        <p
          className="break-words text-xs fg-secondary"
          role="status"
          data-testid="shared-container-invite-modal-withheld-file-paths"
        >
          {`These files stay out of the share: ${withheldFilePaths.join(', ')}`}
        </p>
      )}
      {withheldSymlinkPaths.length > 0 && (
        <p
          // The sentence wraps on its own, but the paths it ends with are
          // single unbreakable tokens that can be wider than the dialog.
          className="break-words text-xs fg-secondary"
          role="status"
          data-testid="shared-container-invite-modal-withheld-symlinks"
        >
          {`${withheldSymlinkPaths.length === 1 ? 'This symbolic link points' : 'These symbolic links point'} outside the repository, so ${withheldSymlinkPaths.length === 1 ? 'it stays' : 'they stay'} out of the share: ${withheldSymlinkPaths.join(', ')}`}
        </p>
      )}

      {selectableFilePaths.length > 0 && (
        <fieldset
          className="space-y-1 pt-1"
          data-testid="shared-container-invite-modal-file-scope"
        >
          <legend className="text-xs font-medium fg-primary">
            {isCoworkContainer ? 'Files in this workspace' : 'Files not in git'}
          </legend>
          {/*
            The one sentence that tells the owner which direction a tick
            points: every file is included, so the checkbox is how a file
            is left out. Only a legacy Cowork allowlist reads the other way.
          */}
          {!fileScopeIsAllowlist && (
            <p
              className="text-xs fg-secondary"
              data-testid="shared-container-invite-modal-file-scope-hint"
            >
              These files are included. Untick any you would rather keep to
              yourself.
            </p>
          )}
          {candidateDirectories.length > 0 && (
            <div
              className="space-y-0.5 pb-1"
              data-testid="shared-container-invite-modal-file-scope-folders"
            >
              {candidateDirectories.map((group) => {
                const allIncluded = group.paths.every((path) =>
                  includedFileSet.has(path),
                );
                const hasBudgetCappedFile = group.paths.some((path) =>
                  budgetCappedFileSet.has(path),
                );
                return (
                  <ChoiceField
                    key={group.directory}
                    label={
                      <span className="break-all">
                        {`${group.directory}/ (${group.paths.length} files)`}
                      </span>
                    }
                    checked={allIncluded}
                    disabled={fileScopeSaving || hasBudgetCappedFile}
                    data-testid={`shared-container-invite-modal-file-scope-folder-${group.directory}`}
                    onChange={(event) =>
                      onDirectoryScopeChange(group.paths, event.target.checked)
                    }
                  />
                );
              })}
              <p className="text-xs fg-secondary">
                {fileScopeIsAllowlist
                  ? 'Ticking a folder includes the files in it right now. Files you add to that folder later are not shared until you share again.'
                  : 'Unticking a folder leaves out the files in it right now. Files you add to that folder later are shared the next time this publishes.'}
              </p>
            </div>
          )}
          {/*
            Repository paths run deeper than the modal is wide, and this
            checkbox is the owner's decision about whether the file leaves
            their machine. An ellipsis would eat the basename that
            identifies it, so the label wraps to the whole path instead;
            `min-w-0` is what lets it, since a flex child otherwise refuses
            to shrink below its content and overflows the dialog sideways
            (ChoiceField's text column carries it).
          */}
          {selectableFilePaths.map((path) => {
            const budgetCapped = budgetCappedFileSet.has(path);
            return (
              <ChoiceField
                key={path}
                label={<span className="break-all">{path}</span>}
                checked={includedFileSet.has(path)}
                disabled={fileScopeSaving || budgetCapped}
                data-testid={`shared-container-invite-modal-file-review-${path}`}
                onChange={(event) =>
                  onFileScopeChange(path, event.target.checked)
                }
              />
            );
          })}
          {preview.untrackedCandidateCount >
            preview.untrackedCandidates.length && (
            <p className="text-xs fg-secondary">
              {isCoworkContainer
                ? `Showing the first ${preview.untrackedCandidates.length} of ${preview.untrackedCandidateCount} files.`
                : `Showing the first ${preview.untrackedCandidates.length} of ${preview.untrackedCandidateCount} untracked files.`}
            </p>
          )}
        </fieldset>
      )}

      {(preview.notes.length > 0 || preview.prompts.length > 0) && (
        <div
          className="space-y-1 pt-1"
          data-testid="shared-container-invite-modal-workspace-items"
        >
          <p className="text-xs fg-secondary">
            {isCoworkContainer
              ? `Notes and prompts belong to the whole ${CHAT_LABEL} project, not just this ${noun}. Included unless you untick them.`
              : 'Included unless you untick them.'}
          </p>
          {preview.notes.length > 0 && (
            <fieldset
              className="space-y-1"
              data-testid="shared-container-invite-modal-note-scope"
            >
              <legend className="text-xs font-medium fg-primary">Notes</legend>
              {preview.notes.map((note) => (
                <ChoiceField
                  key={note.id}
                  label={<span className="block truncate">{note.title}</span>}
                  checked={includedNoteIds.includes(note.id)}
                  disabled={fileScopeSaving}
                  data-testid={`shared-container-invite-modal-note-scope-${note.id}`}
                  onChange={(event) =>
                    onNoteScopeChange(note.id, event.target.checked)
                  }
                />
              ))}
            </fieldset>
          )}
          {preview.prompts.length > 0 && (
            <fieldset
              className="space-y-1"
              data-testid="shared-container-invite-modal-prompt-scope"
            >
              <legend className="text-xs font-medium fg-primary">
                Prompts
              </legend>
              {preview.prompts.map((prompt) => (
                <ChoiceField
                  key={prompt.id}
                  label={<span className="block truncate">{prompt.title}</span>}
                  checked={includedPromptIds.includes(prompt.id)}
                  disabled={fileScopeSaving}
                  data-testid={`shared-container-invite-modal-prompt-scope-${prompt.id}`}
                  onChange={(event) =>
                    onPromptScopeChange(prompt.id, event.target.checked)
                  }
                />
              ))}
            </fieldset>
          )}
        </div>
      )}

      {/*
        Run sharing (CAN-2831). Code worktrees only, and only where the
        recipient could act on it: the whole feature is macOS-only for now
        and behind its own flag, so an unsupported host hides the block
        rather than offering a toggle that publishes nothing.

        The environment list renders every derived NAME verbatim, never a
        count. A name like `ACME_INTERNAL_BILLING_TOKEN` is itself
        information about this codebase, and the owner is agreeing to send
        it, so summarizing it as "3 variables" would ask for consent to
        something they were not shown. Values are never derived, never
        stored here, and never published -- the `.env.example` these names
        came from is still withheld as credential-shaped.
      */}
      {runSharingSupported && !isCoworkContainer && (
        <fieldset
          className="space-y-1 pt-1"
          data-testid="shared-container-invite-modal-run-scope"
        >
          <legend className="text-xs font-medium fg-primary">
            Let your teammate run this
          </legend>
          <ChoiceField
            label="Share the commands that start this app. Your teammate decides whether to run them on their own machine."
            checked={runSharingEnabled}
            disabled={fileScopeSaving}
            data-testid="shared-container-invite-modal-run-scope-toggle"
            onChange={(event) => onRunSharingChange(event.target.checked)}
          />
          {runSharingEnabled && availableRunScripts.length === 0 && (
            <p
              className="text-xs fg-secondary"
              data-testid="shared-container-invite-modal-run-scope-empty"
            >
              This project has no scripts to share yet. Add one in the Scripts
              panel and it will show up here.
            </p>
          )}
          {runSharingEnabled && availableRunScripts.length > 0 && (
            <p className="text-xs fg-quaternary">
              {`${includedRunScripts.length} of ${MAX_PUBLISHABLE_RUN_SCRIPTS} selected`}
            </p>
          )}
          {runSharingEnabled &&
            availableRunScripts.map((scriptName) => {
              // A ticked script that produced no command means its command
              // was dropped (an unredactable absolute path, or a
              // safety-deny pattern refused at publish). Say so per row: a
              // silently missing command is the difference between the
              // recipient being able to start the app and not.
              const selected = includedRunScripts.includes(scriptName);
              const resolved =
                preview.run?.commands.some(
                  (command) => command.name === scriptName,
                ) === true;
              // The cap blocks new ticks only. An already-ticked row stays
              // interactive so the publisher can always swap a selection
              // without first hunting for something to untick.
              const atCap =
                !selected &&
                includedRunScripts.length >= MAX_PUBLISHABLE_RUN_SCRIPTS;
              return (
                <div key={scriptName} className="space-y-0.5">
                  <ChoiceField
                    label={
                      <span className="block truncate">
                        {getScriptDisplayName(scriptName)}
                      </span>
                    }
                    checked={selected}
                    disabled={fileScopeSaving || atCap}
                    data-testid={`shared-container-invite-modal-run-scope-${scriptName}`}
                    onChange={(event) =>
                      onRunScriptScopeChange(scriptName, event.target.checked)
                    }
                  />
                  {selected && !resolved && (
                    <p
                      className="pl-6 text-xs fg-secondary"
                      data-testid={`shared-container-invite-modal-run-scope-unresolved-${scriptName}`}
                    >
                      {`There is no ${getScriptDisplayName(scriptName)} command to share for this project yet.`}
                    </p>
                  )}
                </div>
              );
            })}
          {runSharingEnabled && preview.run && (
            <div
              className="space-y-0.5 pt-1"
              data-testid="shared-container-invite-modal-run-env"
            >
              <p className="text-xs font-medium fg-primary">
                Environment variable names, never values
              </p>
              {preview.run.requiredEnv.length === 0 ? (
                <p className="text-xs fg-secondary">
                  {`${brandText.appName} found no environment variable names to pass along. Your teammate may still need to configure the app themselves.`}
                </p>
              ) : (
                <ul className="space-y-0.5 text-xs fg-secondary">
                  {preview.run.requiredEnv.map((name) => (
                    <li key={name} className="break-all">
                      {name}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {runSharingEnabled && (
            <p className="text-xs fg-secondary">
              Running happens on your teammate's machine, with their own tools.
              Nothing they change comes back to you.
            </p>
          )}
        </fieldset>
      )}
    </Disclosure>
  );
}
