import { useCallback, useState, type JSX } from 'react';
import {
  Button,
  Notice,
  SettingsSelect,
  type SettingsSelectItem,
} from '@canopy/ui-shared/components';
import { TrashIcon } from '@canopy/ui-shared/icons/AppIcons';
import type {
  BrowserSearchEngine,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import {
  BUILT_IN_BROWSER_SEARCH_ENGINES,
  DEFAULT_BROWSER_SEARCH_ENGINE_ID,
  MAX_BROWSER_SEARCH_ENGINE_NAME_LENGTH,
  MAX_CUSTOM_BROWSER_SEARCH_ENGINES,
  browserSearchUrlTemplateError,
} from '@canopy/desktop-shared/lib/browser-search-engines';
import {
  selectActiveSearchEngine,
  useBrowserStore,
} from '@/stores/browserStore';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsTextField,
} from './SettingsLayout';

type SearchPreferences = Required<
  Pick<
    PreferencesData,
    'inAppBrowserSearchEngineId' | 'inAppBrowserCustomSearchEngines'
  >
>;

function engineOptions(
  custom: readonly BrowserSearchEngine[],
): readonly SettingsSelectItem[] {
  const builtIn = BUILT_IN_BROWSER_SEARCH_ENGINES.map((engine) => ({
    value: engine.id,
    label: engine.name,
    testId: `settings-browser-search-engine-option-${engine.id}`,
  }));
  if (custom.length === 0) {
    return builtIn;
  }
  return [
    { label: 'Built in', options: builtIn },
    {
      label: 'Your search engines',
      options: custom.map((engine) => ({
        value: engine.id,
        label: engine.name,
        testId: `settings-browser-search-engine-option-${engine.id}`,
      })),
    },
  ];
}

/**
 * Settings → Browser search engines, as in Chrome: the engine the address bar
 * searches with when what was typed is not a URL, and engines of your own,
 * each a name and a URL with `%s` where the search words go.
 */
export function BrowserSearchEngineSettings(): JSX.Element {
  const searchEngineId = useBrowserStore((state) => state.searchEngineId);
  const customSearchEngines = useBrowserStore(
    (state) => state.customSearchEngines,
  );
  const activeEngine = useBrowserStore(selectActiveSearchEngine);
  const applySearchPreferences = useBrowserStore(
    (state) => state.applySearchPreferences,
  );
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [name, setName] = useState('');
  const [urlTemplate, setUrlTemplate] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const save = useCallback(
    (next: SearchPreferences): void => {
      const previous: SearchPreferences = {
        inAppBrowserSearchEngineId: searchEngineId,
        inAppBrowserCustomSearchEngines: [...customSearchEngines],
      };
      applySearchPreferences(next);
      setSaving(true);
      setSaveFailed(false);
      void window.api
        .savePreferences(next)
        .then((preferences) => {
          applySearchPreferences(preferences);
        })
        .catch(() => {
          applySearchPreferences(previous);
          setSaveFailed(true);
        })
        .finally(() => {
          setSaving(false);
        });
    },
    [applySearchPreferences, customSearchEngines, searchEngineId],
  );

  const handleChoose = useCallback(
    (id: string): void => {
      save({
        inAppBrowserSearchEngineId: id,
        inAppBrowserCustomSearchEngines: [...customSearchEngines],
      });
    },
    [customSearchEngines, save],
  );

  const handleAdd = useCallback((): void => {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setAddError('Enter a name.');
      return;
    }
    if (trimmedName.length > MAX_BROWSER_SEARCH_ENGINE_NAME_LENGTH) {
      setAddError('Enter a shorter name.');
      return;
    }
    const templateError = browserSearchUrlTemplateError(urlTemplate);
    if (templateError !== null) {
      setAddError(templateError);
      return;
    }
    setAddError(null);
    save({
      inAppBrowserSearchEngineId: searchEngineId,
      inAppBrowserCustomSearchEngines: [
        ...customSearchEngines,
        {
          id: `custom-${crypto.randomUUID()}`,
          name: trimmedName,
          urlTemplate: urlTemplate.trim(),
        },
      ],
    });
    setName('');
    setUrlTemplate('');
  }, [customSearchEngines, name, save, searchEngineId, urlTemplate]);

  const handleDelete = useCallback(
    (id: string): void => {
      save({
        // Deleting the engine in use goes back to Google.
        inAppBrowserSearchEngineId:
          id === activeEngine.id
            ? DEFAULT_BROWSER_SEARCH_ENGINE_ID
            : searchEngineId,
        inAppBrowserCustomSearchEngines: customSearchEngines.filter(
          (engine) => engine.id !== id,
        ),
      });
    },
    [activeEngine.id, customSearchEngines, save, searchEngineId],
  );

  const atLimit =
    customSearchEngines.length >= MAX_CUSTOM_BROWSER_SEARCH_ENGINES;

  return (
    <>
      <SettingsSection
        title="Search engine"
        dataTestId="settings-browser-search-engine"
      >
        {saveFailed && (
          <Notice intent="destructive">
            Your search engine changes couldn’t be saved. Try again.
          </Notice>
        )}
        <SettingsGroup>
          <SettingsRow
            label="Search engine used in the address bar"
            description="Words you type that aren’t a URL search here."
            control={
              <SettingsSelect
                width="field"
                aria-label="Search engine used in the address bar"
                data-testid="settings-browser-search-engine-select"
                options={engineOptions(customSearchEngines)}
                value={activeEngine.id}
                disabled={saving}
                onValueChange={handleChoose}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Your search engines"
        description="Add a site that searches with a URL. Put %s where the search words go."
        dataTestId="settings-browser-custom-search-engines"
      >
        <SettingsGroup>
          {customSearchEngines.map((engine) => (
            <SettingsRow
              key={engine.id}
              label={engine.name}
              description={
                <span className="font-mono break-all">
                  {engine.urlTemplate}
                </span>
              }
              dataTestId={`settings-browser-custom-search-engine-${engine.id}`}
              control={
                <Button
                  size="compact"
                  variant="ghost"
                  iconOnly
                  aria-label={`Delete ${engine.name}`}
                  disabled={saving}
                  onClick={(): void => handleDelete(engine.id)}
                >
                  <TrashIcon size="sm" />
                </Button>
              }
            />
          ))}
          <SettingsRow
            label="Name"
            htmlFor="settings-browser-search-engine-name"
            control={
              <SettingsTextField
                id="settings-browser-search-engine-name"
                type="text"
                value={name}
                placeholder="My search engine"
                data-testid="settings-browser-search-engine-name"
                onChange={(event): void => {
                  setName(event.target.value);
                  setAddError(null);
                }}
              />
            }
          />
          <SettingsRow
            label="URL"
            description="Use %s in place of the search words."
            htmlFor="settings-browser-search-engine-url"
            control={
              <div className="flex items-center gap-2">
                <SettingsTextField
                  id="settings-browser-search-engine-url"
                  type="text"
                  mono
                  spellCheck={false}
                  value={urlTemplate}
                  placeholder="https://example.com/search?q=%s"
                  aria-invalid={addError !== null}
                  data-testid="settings-browser-search-engine-url"
                  onChange={(event): void => {
                    setUrlTemplate(event.target.value);
                    setAddError(null);
                  }}
                  onKeyDown={(event): void => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      handleAdd();
                    }
                  }}
                />
                <Button
                  size="compact"
                  variant="secondary"
                  data-testid="settings-browser-search-engine-add"
                  disabled={saving || atLimit}
                  onClick={handleAdd}
                >
                  Add
                </Button>
              </div>
            }
          >
            {addError !== null && (
              <Notice
                intent="destructive"
                data-testid="settings-browser-search-engine-error"
              >
                {addError}
              </Notice>
            )}
            {atLimit && (
              <Notice intent="neutral">
                {`You can add up to ${MAX_CUSTOM_BROWSER_SEARCH_ENGINES} search engines.`}
              </Notice>
            )}
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
    </>
  );
}
