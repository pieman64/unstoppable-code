'use client';

import { useEffect, type JSX, type ReactNode } from 'react';
import { useWorkspaceCapabilities } from '@canopy/app-state/CanopyClientProvider';
import {
  lifetimeLimitTargetKey,
  useLifetimeLimitStore,
} from '@canopy/app-state/delegation/lifetime-limit-store';
import { LifetimeLimitNoticeDisplay } from '@canopy/ui-shared/components/chat/subagents/panel/LifetimeLimitNoticeDisplay';

export type LifetimeLimitNoticeProps = {
  readonly projectId: string;
  /** Target local worktree id, also used for capabilitiesFor routing. */
  readonly worktreeId: string;
} & (
  | { readonly placement: 'panel' }
  | { readonly placement: 'chat'; readonly chatId: string }
);

/** Aligns the panel notice with the panel header's padding; the composer column spaces its own notices. */
function PanelInset({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return <div className="shrink-0 px-3 pt-2">{children}</div>;
}

function StatusLifetimeLimitNotice(
  props: LifetimeLimitNoticeProps & { readonly canExtend: boolean },
): JSX.Element | null {
  const key = lifetimeLimitTargetKey(props);
  const entry = useLifetimeLimitStore((state) => state.entries[key]);
  const load = useLifetimeLimitStore((state) => state.load);
  const extend = useLifetimeLimitStore((state) => state.extend);
  const { projectId, worktreeId } = props;
  useEffect(() => {
    void load({ projectId, worktreeId });
  }, [load, projectId, worktreeId]);
  const status = entry?.status;
  if (!status) return null;
  if (status.kind !== 'available') {
    return props.placement === 'panel' ? (
      <PanelInset>
        <LifetimeLimitNoticeDisplay state="unavailable" />
      </PanelInset>
    ) : null;
  }
  if (
    !status.atLimit ||
    (props.placement === 'chat' &&
      !status.refusedChatIds.includes(props.chatId))
  )
    return null;
  const notice = (
    <LifetimeLimitNoticeDisplay
      state="full"
      atCap={status.atCap}
      canExtend={props.canExtend && status.canExtend}
      extension={entry.extension}
      onExtend={() => {
        void extend({ projectId, worktreeId });
      }}
    />
  );
  return props.placement === 'panel' ? (
    <PanelInset>{notice}</PanelInset>
  ) : (
    notice
  );
}

/** Shared panel/composer notice; worktreeId is the target local id used by the client router. */
export function LifetimeLimitNotice(
  props: LifetimeLimitNoticeProps,
): JSX.Element | null {
  const capabilities = useWorkspaceCapabilities(props.worktreeId);
  if (capabilities.delegationLifetimeStatusReads === true) {
    return (
      <StatusLifetimeLimitNotice
        {...props}
        canExtend={capabilities.delegationLifetimeLimitExtension === true}
      />
    );
  }
  if (
    capabilities.delegationLifetimeStatusGated === true &&
    props.placement === 'panel'
  ) {
    return (
      <PanelInset>
        <LifetimeLimitNoticeDisplay state="gated" />
      </PanelInset>
    );
  }
  return null;
}
