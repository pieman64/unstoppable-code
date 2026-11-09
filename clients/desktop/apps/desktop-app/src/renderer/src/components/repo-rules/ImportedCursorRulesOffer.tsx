import { useEffect, useState, type JSX } from 'react';
import { useCanopyClient } from '@canopy/app-state';
import { Button, Surface } from '@canopy/ui-shared/components';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

/** Presence checks are metadata-only, but an import can add many projects. */
const MAX_PRESENCE_CHECKS = 10;

export interface ImportedWorkspace {
  readonly workspaceId: string;
  readonly displayName: string;
}

interface ImportedCursorRulesOfferProps {
  readonly workspaces: readonly ImportedWorkspace[];
  /** Opens the Cursor rules review for one just-imported workspace. */
  readonly onReview: (workspaceId: string) => void;
}

/**
 * Import results offer to review Cursor rules (CAN-2053) for each
 * just-imported project whose repository root hints at them. The hint never
 * reads rule contents; every offer carries its explicit workspace id.
 */
export function ImportedCursorRulesOffer({
  workspaces,
  onReview,
}: ImportedCursorRulesOfferProps): JSX.Element | null {
  const client = useCanopyClient();
  const [withRules, setWithRules] = useState<readonly ImportedWorkspace[]>([]);
  const key = workspaces.map((workspace) => workspace.workspaceId).join('\n');

  useEffect(() => {
    if (client.capabilities.repoRulesImport !== true) return;
    let active = true;
    const candidates = workspaces.slice(0, MAX_PRESENCE_CHECKS);
    void Promise.all(
      candidates.map((workspace) =>
        client
          .query('editorSetup.presence', { workspaceId: workspace.workspaceId })
          .then((presence) => presence.cursorRulesPresent)
          .catch(() => false),
      ),
    ).then((present) => {
      if (active)
        setWithRules(candidates.filter((_, index) => present[index] === true));
    });
    return (): void => {
      active = false;
    };
    // `key` stands in for the workspace list's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);

  if (withRules.length === 0) return null;
  return (
    <Surface
      variant="outline"
      gap="inline"
      size="small"
      data-testid="import-projects-cursor-rules"
    >
      <div className="flex flex-col gap-2 px-3 py-2">
        <p className="text-s fg-primary">
          {withRules.length === 1
            ? 'This project has Cursor rules.'
            : 'These projects have Cursor rules.'}
        </p>
        <p className="mt-0.5 text-xs fg-secondary">
          Review them to use them in new chats. The repository stays unchanged.
        </p>
        <ul className="flex flex-col gap-1">
          {withRules.map((workspace) => (
            <li
              key={workspace.workspaceId}
              className="flex items-center justify-between gap-2"
            >
              <span
                className={`min-w-0 truncate text-s fg-primary ${REPLAY_MASK_CLASS}`}
              >
                {workspace.displayName}
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={(): void => onReview(workspace.workspaceId)}
                data-testid={`import-projects-cursor-rules-review-${workspace.workspaceId}`}
              >
                Review Cursor rules
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </Surface>
  );
}
