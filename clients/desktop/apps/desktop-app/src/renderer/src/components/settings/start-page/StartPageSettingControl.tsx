import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react';
import type { ProjectStartPage } from '@canopy/protocol/start-page';
import type { HomeDiscoveryTarget } from '@canopy/desktop-shared/types';
import {
  FloatingPickerMenu,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionLabel,
  Button,
  PickerTriggerChevron,
} from '@canopy/ui-shared';
import { searchFiles, type FileSearchResult } from '@/lib/fuzzySearch';
import {
  isHttpStartPageUrl,
  startPageLabel,
} from '@/lib/start-page/project-start-page';

export type StartPageSettingValue = ProjectStartPage | null | undefined;

interface StartPageSettingControlProps {
  workspaceId: string;
  target: HomeDiscoveryTarget;
  projectType: 'cowork' | 'single-repo' | 'multi-repo';
  value: StartPageSettingValue;
  onChange: (value: StartPageSettingValue) => void;
  onValidityChange?: (isValid: boolean) => void;
  allowUseTeamSetting?: boolean;
}

type Choice = 'team' | 'chat' | 'file' | 'url';

const CHOICE_LABELS: Record<Choice, string> = {
  team: 'Use team setting',
  chat: 'New chat (default)',
  file: 'A file…',
  url: 'A web page…',
};

function choiceFor(
  value: StartPageSettingValue,
  allowUseTeamSetting: boolean,
): Choice {
  if (value === undefined && allowUseTeamSetting) return 'team';
  if (!value) return 'chat';
  return value.kind;
}

export function StartPageSettingControl({
  workspaceId,
  target,
  projectType,
  value,
  onChange,
  onValidityChange,
  allowUseTeamSetting = false,
}: StartPageSettingControlProps): JSX.Element {
  const [choice, setChoice] = useState<Choice>(() =>
    choiceFor(value, allowUseTeamSetting),
  );
  const [query, setQuery] = useState('');
  const [repos, setRepos] = useState<
    Awaited<ReturnType<typeof window.api.homeFileIndex>>['repos']
  >([]);
  const [url, setUrl] = useState(value?.kind === 'url' ? value.url : '');
  const [loadFailed, setLoadFailed] = useState(false);
  const [choiceOpen, setChoiceOpen] = useState(false);
  const choiceTriggerRef = useRef<HTMLButtonElement>(null);
  const choiceMenuId = useId();

  useEffect(() => {
    setChoice(choiceFor(value, allowUseTeamSetting));
    if (value?.kind === 'file') setQuery(value.path);
    if (value?.kind === 'url') setUrl(value.url);
    onValidityChange?.(true);
  }, [allowUseTeamSetting, onValidityChange, value]);

  useEffect(() => {
    if (choice !== 'file') return;
    let canceled = false;
    setLoadFailed(false);
    void window.api
      .homeFileIndex({ workspaceId, target })
      .then((response) => {
        if (!canceled) setRepos(response.repos);
      })
      .catch(() => {
        if (!canceled) setLoadFailed(true);
      });
    return (): void => {
      canceled = true;
    };
  }, [choice, target, workspaceId]);

  const files = useMemo(() => searchFiles(query, repos, 30), [query, repos]);
  const chooseFile = (file: FileSearchResult): void => {
    onChange({
      kind: 'file',
      path: file.relativePath,
      ...(projectType === 'multi-repo' ? { repoId: file.repoId } : {}),
    });
    setQuery(file.relativePath);
    onValidityChange?.(true);
  };

  const applyUrl = (): void => {
    const trimmed = url.trim();
    if (isHttpStartPageUrl(trimmed)) {
      onChange({ kind: 'url', url: trimmed });
      onValidityChange?.(true);
    } else {
      onValidityChange?.(false);
    }
  };

  const selectedFileExists =
    value?.kind !== 'file' ||
    repos.length === 0 ||
    repos.some((repo) =>
      repo.files.some(
        (file) =>
          file.relativePath === value.path &&
          (value.repoId === undefined || repo.repoId === value.repoId),
      ),
    );

  const choose = (next: Choice): void => {
    setChoice(next);
    setChoiceOpen(false);
    if (next === 'team') {
      onChange(undefined);
      onValidityChange?.(true);
    } else if (next === 'chat') {
      onChange(null);
      onValidityChange?.(true);
    } else if (next === 'file') {
      setQuery(value?.kind === 'file' ? value.path : '');
      onValidityChange?.(value?.kind === 'file');
    } else {
      setUrl(value?.kind === 'url' ? value.url : '');
      onValidityChange?.(value?.kind === 'url');
    }
  };

  const choices: Choice[] = allowUseTeamSetting
    ? ['team', 'chat', 'file', 'url']
    : ['chat', 'file', 'url'];

  return (
    <div className="rounded-lg border p-4" data-testid="start-page-setting">
      <div className="text-s font-medium fg-primary">Start page</div>
      <div className="mt-1 text-xs fg-secondary">
        Choose what opens first in each new work area.
      </div>
      <label
        className="mt-4 block text-xs font-medium fg-secondary"
        htmlFor="start-page-choice"
      >
        Open on start
      </label>
      <Button
        ref={choiceTriggerRef}
        id="start-page-choice"
        variant="secondary"
        size="compact"
        className="mt-1 w-full"
        onClick={() => setChoiceOpen((open) => !open)}
        aria-haspopup="listbox"
        aria-expanded={choiceOpen}
        aria-controls={choiceOpen ? choiceMenuId : undefined}
        data-testid="start-page-choice-trigger"
      >
        <span className="min-w-0 flex-1 truncate">{CHOICE_LABELS[choice]}</span>
        <PickerTriggerChevron open={choiceOpen} variant="capsule" />
      </Button>
      <FloatingPickerMenu
        id={choiceMenuId}
        open={choiceOpen}
        onOpenChange={setChoiceOpen}
        anchorRef={choiceTriggerRef}
        placement="bottom-left"
        interaction="listbox"
        role="listbox"
        aria-label="Start page choice"
        data-testid="start-page-choice-menu"
      >
        {choices.map((option) => (
          <PickerMenuOption
            key={option}
            role="option"
            aria-selected={choice === option}
            selected={choice === option}
            onClick={() => choose(option)}
            data-testid={`start-page-choice-${option}`}
          >
            <PickerMenuOptionContent>
              <PickerMenuOptionLabel>
                {CHOICE_LABELS[option]}
              </PickerMenuOptionLabel>
            </PickerMenuOptionContent>
            <PickerMenuOptionCheck selected={choice === option} />
          </PickerMenuOption>
        ))}
      </FloatingPickerMenu>

      {choice === 'file' && (
        <div className="mt-3">
          <input
            aria-label="Find a start page file"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              onValidityChange?.(
                value?.kind === 'file' && event.target.value === value.path,
              );
            }}
            placeholder="Find a file"
            className="w-full rounded-lg border bg-secondary/30 px-3 py-2 text-s fg-primary outline-none"
          />
          <div className="mt-1 max-h-44 overflow-y-auto rounded-lg border">
            {files.map((file) => (
              <button
                key={`${file.repoId}:${file.relativePath}`}
                type="button"
                className="block w-full truncate px-3 py-2 text-left text-xs fg-primary hover:bg-secondary"
                onClick={() => chooseFile(file)}
              >
                {projectType === 'multi-repo'
                  ? `${file.repoName} / ${file.relativePath}`
                  : file.relativePath}
              </button>
            ))}
          </div>
          {(loadFailed || !selectedFileExists) && (
            <p className="mt-2 text-xs text-warning">File not found</p>
          )}
        </div>
      )}

      {choice === 'url' && (
        <div className="mt-3 flex gap-2">
          <input
            aria-label="Start page URL"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              onValidityChange?.(
                value?.kind === 'url' &&
                  event.target.value.trim() === value.url,
              );
            }}
            onBlur={applyUrl}
            placeholder="https://example.com"
            className="min-w-0 flex-1 rounded-lg border bg-secondary/30 px-3 py-2 text-s fg-primary outline-none"
          />
          <button
            type="button"
            disabled={!isHttpStartPageUrl(url)}
            onClick={applyUrl}
            className="rounded-lg border px-3 py-2 text-xs fg-primary disabled:opacity-50"
          >
            Use
          </button>
        </div>
      )}

      {value && (
        <p className="mt-2 truncate text-xs fg-secondary">
          Opens to: {startPageLabel(value)}
        </p>
      )}
    </div>
  );
}
