import { useMemo, type JSX } from 'react';
import {
  SKILL_SUGGESTION_COPY,
  SkillSuggestionsList,
  type SkillSuggestionListItem,
} from '@canopy/ui-app';
import { DialogModal } from '@canopy/ui-shared/components';
import {
  SKILL_SUGGESTION_MODAL_SOURCE,
  type SkillSuggestion,
} from '@canopy/desktop-shared/lib/skill-suggestions';
import { useCreateSkillFromSuggestion } from '@/lib/createSkillFromSuggestion';
import {
  reportSkillSuggestionResolution,
  useOpenSkillSuggestions,
  useSkillSuggestionStore,
  useSkillSuggestionsFlagEnabled,
} from '@/stores/skillSuggestionStore';

function toListItem(suggestion: SkillSuggestion): SkillSuggestionListItem {
  return {
    id: suggestion.id,
    kind: suggestion.kind,
    title: suggestion.title,
    summary: suggestion.summary,
    occurrenceCount: suggestion.occurrenceCount,
    chainSkills: suggestion.chainSkills,
    // Main sends none for private work; keep the rule on this side too.
    examples: suggestion.isPrivate ? [] : suggestion.examples,
    ownerLabel: suggestion.ownerLabel,
    lastSeenAt: suggestion.lastSeenAt,
  };
}

/**
 * Every open repeat-task skill suggestion (CAN-385), opened from Settings or
 * App Advisor. Unlike the composer banner it is never throttled. Following
 * the modal rule there is no Cancel: the X or a click outside closes it.
 */
export function SkillSuggestionsModal(): JSX.Element | null {
  const open = useSkillSuggestionStore((state) => state.modalOpen);
  const setOpen = useSkillSuggestionStore((state) => state.setModalOpen);
  const flagEnabled = useSkillSuggestionsFlagEnabled();
  const suggestions = useOpenSkillSuggestions(open && flagEnabled);
  const create = useCreateSkillFromSuggestion();
  const byId = useMemo(
    () => new Map((suggestions ?? []).map((s) => [s.id, s])),
    [suggestions],
  );
  const items = useMemo(
    () => (suggestions ?? []).map(toListItem),
    [suggestions],
  );
  const busyIds = useMemo(
    () => new Set(create.pendingId ? [create.pendingId] : []),
    [create.pendingId],
  );

  if (!open || !flagEnabled) return null;

  const close = (): void => setOpen(false);
  return (
    <DialogModal
      onClose={close}
      title={SKILL_SUGGESTION_COPY.modalTitle}
      maxWidth="xl"
      headerBorder={false}
      dataTestId="skill-suggestions-modal"
    >
      <div className="">
        {suggestions === null ? null : (
          <SkillSuggestionsList
            suggestions={items}
            busyIds={busyIds}
            onCreate={(id) => {
              const suggestion = byId.get(id);
              if (!suggestion) return;
              create.start(suggestion, () => {
                reportSkillSuggestionResolution({
                  source: SKILL_SUGGESTION_MODAL_SOURCE,
                  suggestionId: id,
                  resolution: 'accepted',
                });
                close();
              });
            }}
            onDismiss={(id) => {
              reportSkillSuggestionResolution({
                source: SKILL_SUGGESTION_MODAL_SOURCE,
                suggestionId: id,
                resolution: 'dismissed',
              });
            }}
          />
        )}
      </div>
    </DialogModal>
  );
}
