import type { JSX } from 'react';
import type { LedgerActorKind } from '@canopy/protocol/canopy-core';
import {
  AgentAssistantIcon,
  ChatIcon,
  PersonIcon,
  PipelineIcon,
  SummaryIcon,
  type AppIcon,
} from '../../icons/AppIcons';
import {
  planCommentAvatarColor,
  planCommentInitials,
} from '../../lib/plan-comments';
import { SubagentIcon } from '../chat/subagents/common/SubagentIcon';
import { ledgerActorReplayClass } from './ledger-entry-attribution';

/** `large` beside a Feed row (32px); `small` in the panel and on replies. */
export type LedgerActorAvatarSize = 'large' | 'small';

/** An avatar disc's box and type size, shared by every Ledger avatar. */
export const LEDGER_AVATAR_SIZE_CLASS_NAMES: Readonly<
  Record<LedgerActorAvatarSize, string>
> = {
  large: 'h-8 w-8 text-2xs',
  small: 'h-6 w-6 text-3xs',
};

/** The glyph an avatar disc of each size holds, in pixels. */
export const LEDGER_AVATAR_GLYPH_SIZES: Readonly<
  Record<LedgerActorAvatarSize, number>
> = {
  large: 16,
  small: 13,
};

/**
 * One glyph per kind of actor. A delegate has none here: it takes the one
 * subagent glyph (`SubagentIcon`), as its agent card and its chat do.
 */
const ACTOR_GLYPHS: Readonly<
  Record<Exclude<LedgerActorKind, 'managed_delegation'>, AppIcon>
> = {
  user: PersonIcon,
  chat: ChatIcon,
  pipeline_agent: PipelineIcon,
  background: SummaryIcon,
  ledger_sidecar: AgentAssistantIcon,
};

export interface LedgerActorGlyphProps {
  readonly kind: LedgerActorKind;
  /** Glyph size in pixels. */
  readonly size: number;
  readonly className?: string;
}

/**
 * The glyph of an actor's kind: a person, a chat, a pipeline agent, a
 * delegate, a Summary or the Ledger's own agent. By the kind of actor, never
 * its provider. Decorative: the actor's name always shows beside it.
 */
export function LedgerActorGlyph({
  kind,
  size,
  className,
}: LedgerActorGlyphProps): JSX.Element {
  if (kind === 'managed_delegation') {
    return <SubagentIcon size={size} className={className} />;
  }
  const Glyph = ACTOR_GLYPHS[kind];
  return <Glyph size={size} aria-hidden="true" className={className} />;
}

export interface LedgerActorAvatarProps {
  /** What kind of actor it is; a person (`user`) gets initials, You a glyph. */
  readonly kind: LedgerActorKind;
  /**
   * The name the avatar stands for. A person's initials and color come from
   * it, so on a teammate's row pass the teammate's name.
   */
  readonly name: string;
  readonly size: LedgerActorAvatarSize;
  /** True only for the semantic local user actor, never inferred from name. */
  readonly localUser?: boolean;
}

/**
 * Who wrote a reply or is writing an entry, at a glance: a person's initials
 * on their color (the person glyph for You), or an agent's glyph on a quiet
 * disc. A main entry's avatar is its type instead (`LedgerEntryTypeAvatar`),
 * and its author's glyph sits beside the author's name. Decorative: the name
 * always shows beside it.
 */
export function LedgerActorAvatar({
  kind,
  name,
  size,
  localUser = false,
}: LedgerActorAvatarProps): JSX.Element {
  const sizeClassName = LEDGER_AVATAR_SIZE_CLASS_NAMES[size];
  if (kind === 'user') {
    const color = planCommentAvatarColor(name);
    return (
      <span
        aria-hidden="true"
        data-testid="ledger-actor-avatar"
        data-actor-kind={kind}
        style={{ backgroundColor: color.backgroundColor, color: color.color }}
        // A teammate's initials are blocked from replay; You's glyph is not.
        className={`${ledgerActorReplayClass(kind, localUser)} flex ${sizeClassName} shrink-0 items-center justify-center rounded-full font-medium`}
      >
        {/* The person on this device is "You", which has no initials. */}
        {localUser ? (
          <LedgerActorGlyph
            kind={kind}
            size={LEDGER_AVATAR_GLYPH_SIZES[size]}
          />
        ) : (
          planCommentInitials(name)
        )}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      data-testid="ledger-actor-avatar"
      data-actor-kind={kind}
      className={`flex ${sizeClassName} shrink-0 items-center justify-center rounded-full bg-secondary fg-secondary`}
    >
      <LedgerActorGlyph kind={kind} size={LEDGER_AVATAR_GLYPH_SIZES[size]} />
    </span>
  );
}
