import { useState, type JSX } from 'react';
import type {
  PlanDetectionRule,
  PlanDetectionRuleKind,
} from '@canopy/desktop-shared/types';

function isPlanDetectionRuleKind(
  value: string,
): value is PlanDetectionRuleKind {
  return value === 'include' || value === 'exclude';
}

export interface InheritedRuleRow {
  rule: PlanDetectionRule;
  /** Provenance chip text, e.g. 'built-in' | 'global' | 'canopy.json'. */
  origin: string;
  /** Whether this inherited rule is currently disabled at this tier. */
  disabled: boolean;
}

export interface PlanDetectionRulesEditorProps {
  inherited: InheritedRuleRow[];
  customRules: PlanDetectionRule[];
  onToggleInherited?: (ruleId: string, disabled: boolean) => void;
  onAddCustomRule: (rule: Omit<PlanDetectionRule, 'id'>) => void;
  onRemoveCustomRule: (ruleId: string) => void;
  /** When true, inherited rows show no enable toggle (global tier has no parent). */
  hideInheritedToggle?: boolean;
  dataTestIdPrefix: string;
}

export function PlanDetectionRulesEditor({
  inherited,
  customRules,
  onToggleInherited,
  onAddCustomRule,
  onRemoveCustomRule,
  hideInheritedToggle,
  dataTestIdPrefix,
}: PlanDetectionRulesEditorProps): JSX.Element {
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
    onAddCustomRule({
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
    <section className="space-y-4" data-testid={`${dataTestIdPrefix}-editor`}>
      {inherited.length > 0 && (
        <div className="space-y-2 rounded-md border bg-card/40 p-3">
          <h3 className="text-s font-medium fg-primary">Inherited rules</h3>
          <ul className="divide-y">
            {inherited.map(({ rule, origin, disabled }) => (
              <li
                key={rule.id}
                data-testid={`${dataTestIdPrefix}-inherited-${rule.id}`}
                className="flex items-center justify-between gap-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-s fg-primary">
                    {rule.label}{' '}
                    <span className="text-xs fg-secondary">
                      ({rule.kind} · {origin})
                    </span>
                  </div>
                  <div className="truncate font-mono text-xs fg-secondary">
                    {rule.pattern}
                  </div>
                </div>
                {!hideInheritedToggle && onToggleInherited && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!disabled}
                    aria-label={rule.label}
                    onClick={(): void => onToggleInherited(rule.id, !disabled)}
                    className={`focus-ring relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                      !disabled ? 'bg-accent' : 'bg-muted'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-base shadow transition-transform ${
                        !disabled ? 'translate-x-4' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-s font-medium fg-primary">Custom rules</h3>
        <div className="flex flex-wrap gap-2">
          <select
            value={kind}
            aria-label="Rule type"
            onChange={(event): void => {
              if (isPlanDetectionRuleKind(event.target.value)) {
                setKind(event.target.value);
              }
            }}
            data-testid={`${dataTestIdPrefix}-kind`}
            className="focus-ring rounded-md border bg-base px-2 py-1.5 text-s fg-primary"
          >
            <option value="include">Include</option>
            <option value="exclude">Exclude</option>
          </select>
          <input
            type="text"
            value={label}
            onChange={(event): void => setLabel(event.target.value)}
            placeholder="Label (optional)"
            data-testid={`${dataTestIdPrefix}-label`}
            className="focus-ring min-w-0 flex-1 rounded-md border bg-base px-3 py-1.5 text-s fg-primary"
          />
          <input
            type="text"
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
            data-testid={`${dataTestIdPrefix}-pattern`}
            className="focus-ring min-w-0 flex-1 rounded-md border bg-base px-3 py-1.5 font-mono text-s fg-primary"
          />
          <button
            type="button"
            onClick={handleAdd}
            data-testid={`${dataTestIdPrefix}-add`}
            className="focus-ring rounded-md border bg-secondary px-3 py-1.5 text-s fg-primary transition hover:bg-accent-subtle hover:fg-accent"
          >
            Add rule
          </button>
        </div>
        {error !== null && (
          <p
            className="text-xs fg-destructive"
            data-testid={`${dataTestIdPrefix}-error`}
          >
            {error}
          </p>
        )}
        {customRules.length === 0 ? (
          <p
            className="text-s fg-secondary"
            data-testid={`${dataTestIdPrefix}-empty`}
          >
            No custom rules.
          </p>
        ) : (
          <ul className="divide-y rounded-md border bg-card/40">
            {customRules.map((rule) => (
              <li
                key={rule.id}
                data-testid={`${dataTestIdPrefix}-custom-${rule.id}`}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-s fg-primary">
                    {rule.label}{' '}
                    <span className="text-xs fg-secondary">({rule.kind})</span>
                  </div>
                  <code className="truncate text-xs fg-secondary">
                    {rule.pattern}
                  </code>
                </div>
                <button
                  type="button"
                  onClick={(): void => onRemoveCustomRule(rule.id)}
                  aria-label={`Remove ${rule.label}`}
                  className="focus-ring rounded-md border bg-secondary px-2 py-1 text-xs fg-primary transition hover:bg-accent-subtle hover:fg-accent"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
