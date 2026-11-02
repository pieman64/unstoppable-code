'use client';
import { useState, type JSX } from 'react';
import type {
  SharedMultiRepoCreationStatus,
  SharedMultiRepoEntryPoint,
} from '@canopy/protocol/org-projects';
import { Button } from '@canopy/ui-shared/components';
import {
  OrgSharedMultiRepoSetup,
  type OrgSharedMultiRepoSetupProps,
} from './OrgSharedMultiRepoSetup';

/** Existing settings container chooses the entry point; the setup unit is shared. */
export function OrgSharedMultiRepoSettings({
  sources,
  hostClient,
  onClose,
  multiRepo,
  onReady,
}: {
  readonly sources: OrgSharedMultiRepoSetupProps['sources'];
  readonly hostClient?: OrgSharedMultiRepoSetupProps['hostClient'];
  readonly onClose?: () => void;
  readonly multiRepo: boolean;
  readonly onReady: (
    status: SharedMultiRepoCreationStatus,
    mode: SharedMultiRepoEntryPoint,
  ) => Promise<void>;
}): JSX.Element {
  const [mode, setMode] = useState<SharedMultiRepoEntryPoint>(
    multiRepo ? 'add-repositories' : 'convert',
  );
  const [started, setStarted] = useState(false);
  return (
    <div className="space-y-3">
      {!started && (
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Shared project action"
        >
          <Button
            size="compact"
            variant={
              mode === (multiRepo ? 'add-repositories' : 'convert')
                ? 'primary'
                : 'secondary'
            }
            onClick={() => setMode(multiRepo ? 'add-repositories' : 'convert')}
          >
            {multiRepo ? 'Add repositories' : 'Convert to multi-repo'}
          </Button>
          <Button
            size="compact"
            variant={mode === 'combine' ? 'primary' : 'secondary'}
            onClick={() => setMode('combine')}
          >
            Combine
          </Button>
        </div>
      )}
      <OrgSharedMultiRepoSetup
        key={mode}
        sources={sources}
        hostClient={hostClient}
        onClose={onClose}
        mode={mode}
        onSubmitted={() => setStarted(true)}
        onReady={(status) => onReady(status, mode)}
      />
    </div>
  );
}
