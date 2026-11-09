import { useCallback, useEffect, useState, type JSX } from 'react';
import type {
  CanopyApi,
  PlanDetectionPreferences,
  PlanDetectionRule,
  PlanDetectionRuleKind,
} from '@canopy/desktop-shared/types';
import {
  Button,
  SettingsSelect,
  ToggleSwitch,
  type SettingsSelectOption,
  FieldError,
} from '@canopy/ui-shared/components';
import {
  getGlobalInheritedRows,
  loadPlanDetectionTabState,
  makeRuleId,
  type PlanDetectionTabState,
} from './planDetectionTabState';
import {
  SettingsGroup,
  SettingsPage,
  SettingsLoading,
  SettingsPageMessage,
  SettingsRow,
  SettingsSection,
  SettingsTextField,
} from './SettingsLayout';

const TEST_ID_PREFIX = 'settings-plan-detection';

const RULE_KIND_LABELS: Record<PlanDetectionRuleKind, string> = {
  include: 'Include',
  exclude: 'Exclude',
};

const RULE_KIND_OPTIONS: readonly SettingsSelectOption<PlanDetectionRuleKind>[] =
  [
    { value: 'include', label: 'Include' },
    { value: 'exclude', label: 'Exclude' },
  ];

function isPlanDetectionRuleKind(
  value: string,
): value is PlanDetectionRuleKind {
  return value === 'include' || value === 'exclude';
}

/** The rule's kind and its glob, as one quiet line under the rule's name. */
function RulePattern({ rule }: { rule: PlanDetectionRule }): JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0">{RULE_KIND_LABELS[rule.kind]}</span>
      <span aria-hidden="true">·</span>
      <code className="truncate font-mono">{rule.pattern}</code>
    </span>
  );
}

interface NewRuleRowProps {
  onAdd: (rule: Omit<PlanDetectionRule, 'id'>) => void;
}

/** The custom-rule form: kind, optional label, glob, and the Add action. */
function NewRuleRow({ onAdd }: NewRuleRowProps): JSX.Element {
  const [kind, setKind] = useState<PlanDetectionRuleKind>('include');
  const [label, setLabel] = useState('');
  const [pattern, setPattern] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleAdd = (): void => {
    const trimmedPattern = pattern.trim();
    if (!trimmedPattern) {
      setError('Pattern is required.');
      return;
    }
    onAdd({
      label: label.trim() || trimmedPattern,
      kind,
      pattern: trimmedPattern,
      enabled: true,
    });
    setLabel('');
    setPattern('');
    setError(null);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <SettingsSelect
          options={RULE_KIND_OPTIONS}
          value={kind}
          aria-label="Rule type"
          onValueChange={(next): void => {
            if (isPlanDetectionRuleKind(next)) {
              setKind(next);
            }
          }}
          data-testid={`${TEST_ID_PREFIX}-kind`}
        />
        <SettingsTextField
          type="text"
          width="sm"
          value={label}
          onChange={(event): void => setLabel(event.target.value)}
          placeholder="Label (optional)"
          aria-label="Rule label"
          data-testid={`${TEST_ID_PREFIX}-label`}
        />
        <div className="min-w-0 flex-1">
          <SettingsTextField
            mono
            type="text"
            width="full"
            value={pattern}
            onChange={(event): void => {
              setPattern(event.target.value);
              if (error) {
                setError(null);
              }
            }}
            onKeyDown={(event): void => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleAdd();
              }
            }}
            placeholder="docs/plans/*.md"
            aria-label="Pattern"
            aria-invalid={error !== null}
            data-testid={`${TEST_ID_PREFIX}-pattern`}
          />
        </div>
        <Button
          size="compact"
          className="shrink-0"
          onClick={handleAdd}
          data-testid={`${TEST_ID_PREFIX}-add`}
        >
          Add rule
        </Button>
      </div>
      {error !== null && (
        <FieldError
          id={`${TEST_ID_PREFIX}-error`}
          data-testid={`${TEST_ID_PREFIX}-error`}
        >
          {error}
        </FieldError>
      )}
    </div>
  );
}

export function PlanDetectionTab(): JSX.Element {
  const [state, setState] = useState<PlanDetectionTabState>({
    status: 'loading',
  });

  useEffect((): (() => void) => {
    let cancelled = false;
    const api: CanopyApi = window.api;
    void loadPlanDetectionTabState(api).then((next) => {
      if (!cancelled) {
        setState(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(
    async (next: PlanDetectionPreferences): Promise<void> => {
      setState({ status: 'ready', planDetection: next });
      await window.api.savePreferences({ planDetection: next }).catch(() => {
        // Persistence failure leaves the optimistic UI in place for this
        // session; non-fatal.
      });
    },
    [],
  );

  if (state.status !== 'ready' || !state.planDetection) {
    return (
      <SettingsPage title="Plan detection">
        {state.status === 'error' ? (
          <SettingsPageMessage>
            Unable to load plan detection settings.
          </SettingsPageMessage>
        ) : (
          <SettingsLoading />
        )}
      </SettingsPage>
    );
  }

  const prefs = state.planDetection;
  const builtInRows = getGlobalInheritedRows(prefs);

  const toggleBuiltIn = (ruleId: string, disabled: boolean): void => {
    const set = new Set(prefs.disabledBuiltinRuleIds);
    if (disabled) {
      set.add(ruleId);
    } else {
      set.delete(ruleId);
    }
    void persist({
      ...prefs,
      disabledBuiltinRuleIds: Array.from(set),
    });
  };

  return (
    <SettingsPage
      title="Plan detection"
      description="Files that match an include rule, and no exclude rule, are tracked as plans. Projects can add their own rules."
      dataTestId="settings-tab-plan-detection"
    >
      {builtInRows.length > 0 && (
        <SettingsSection title="Built-in rules">
          <SettingsGroup>
            {builtInRows.map(({ rule, disabled }) => {
              const switchId = `${TEST_ID_PREFIX}-switch-${rule.id}`;
              return (
                <SettingsRow
                  key={rule.id}
                  label={rule.label}
                  htmlFor={switchId}
                  description={<RulePattern rule={rule} />}
                  dataTestId={`${TEST_ID_PREFIX}-inherited-${rule.id}`}
                  control={
                    <ToggleSwitch
                      id={switchId}
                      checked={!disabled}
                      label={rule.label}
                      onChange={(next): void => toggleBuiltIn(rule.id, !next)}
                    />
                  }
                />
              );
            })}
          </SettingsGroup>
        </SettingsSection>
      )}

      <SettingsSection
        title="Custom rules"
        dataTestId={`${TEST_ID_PREFIX}-editor`}
      >
        <SettingsGroup>
          <SettingsRow
            label="New rule"
            description="Include or exclude files whose path matches a glob."
          >
            <NewRuleRow
              onAdd={(rule): void => {
                const next: PlanDetectionRule = { ...rule, id: makeRuleId() };
                void persist({
                  ...prefs,
                  customRules: [...prefs.customRules, next],
                });
              }}
            />
          </SettingsRow>
          {prefs.customRules.length === 0 ? (
            <p
              className="text-s fg-secondary"
              data-testid={`${TEST_ID_PREFIX}-empty`}
            >
              No custom rules.
            </p>
          ) : (
            prefs.customRules.map((rule) => (
              <SettingsRow
                key={rule.id}
                label={rule.label}
                description={<RulePattern rule={rule} />}
                dataTestId={`${TEST_ID_PREFIX}-custom-${rule.id}`}
                control={
                  <Button
                    size="compact"
                    variant="secondary"
                    onClick={(): void => {
                      void persist({
                        ...prefs,
                        customRules: prefs.customRules.filter(
                          (r) => r.id !== rule.id,
                        ),
                      });
                    }}
                    aria-label={`Remove ${rule.label}`}
                  >
                    Remove
                  </Button>
                }
              />
            ))
          )}
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}
