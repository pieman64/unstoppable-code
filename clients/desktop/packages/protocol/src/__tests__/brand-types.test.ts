/**
 * Brand contract type tests.
 *
 * The purpose of this file is twofold:
 *  1. Lock in the runtime contract values that other layers depend on
 *     (route paths, tool names, URL prefixes derived from a BrandCore).
 *  2. Lock in the optional-on-manifest, required-on-runtime distinction by
 *     using `@ts-expect-error` on the runtime side so a future flatten of
 *     the asset types is caught at type-check time.
 */
import {
  BRAND_THEME_TOKEN_NAMES,
  type BrandCore,
  type BrandPackManifest,
  type BrandPackManifestAssets,
  type BrandThemeDefinition,
  type BrandThemeModeTokens,
  type DesktopBrandAssets,
  type DesktopBrandRuntime,
  type WebBrandAssets,
  type WebBrandRuntime,
  buildBrandDefaultThemeCss,
  buildBrandPathPrefix,
  buildDesktopIntegrationRoutes,
  buildInjectedToolNamesForBrand,
  daemonName,
  dedupePreserveOrder,
  joinDesktopIntegrationRoute,
  validateBrandCore,
} from '../brand';

// ---------------------------------------------------------------------------
// Optional-on-manifest, required-on-runtime
// ---------------------------------------------------------------------------

// Should compile: manifest asset slots are optional.
const _manifestMacIcon: BrandPackManifestAssets['macIconIcns'] = undefined;
const _manifestWinIcon: BrandPackManifestAssets['windowsIconIco'] = undefined;
const _manifestLinuxIcon: BrandPackManifestAssets['linuxIconDir'] = undefined;
const _manifestWebIcon: BrandPackManifestAssets['webIconPng'] = undefined;
void _manifestMacIcon;
void _manifestWinIcon;
void _manifestLinuxIcon;
void _manifestWebIcon;

// Must NOT compile: runtime asset slots are required.
// @ts-expect-error desktop runtime macIconIcns must not accept undefined
const _desktopMacIcon: DesktopBrandAssets['macIconIcns'] = undefined;
// @ts-expect-error desktop runtime windowsIconIco must not accept undefined
const _desktopWinIcon: DesktopBrandAssets['windowsIconIco'] = undefined;
// @ts-expect-error desktop runtime linuxIconDir must not accept undefined
const _desktopLinuxIcon: DesktopBrandAssets['linuxIconDir'] = undefined;
// @ts-expect-error desktop runtime webIconPng must not accept undefined
const _desktopWebIcon: DesktopBrandAssets['webIconPng'] = undefined;
// @ts-expect-error web runtime logoSvgUrl must not accept undefined
const _webLogo: WebBrandAssets['logoSvgUrl'] = undefined;
void _desktopMacIcon;
void _desktopWinIcon;
void _desktopLinuxIcon;
void _desktopWebIcon;
void _webLogo;

// ---------------------------------------------------------------------------
// Sample brand fixture for runtime contract tests
// ---------------------------------------------------------------------------

const baseThemeTokens = Object.fromEntries(
  BRAND_THEME_TOKEN_NAMES.map((tokenName) => [tokenName, tokenName]),
) as Record<(typeof BRAND_THEME_TOKEN_NAMES)[number], string>;

const themeRecipe = {
  engine: 'ui-kit-v1',
  base: {
    lighter: '#FFFFFF',
    light: '#F2F2ED',
    dark: '#0B0B0F',
    darker: '#000000',
  },
  accent: '#3DA13D',
  contrast: 1,
  neutralTint: 0.005,
  surfaceHue: 100,
  borderContrast: 0.5,
  darkAccentTone: 0,
  tuning: {
    neutralTintScale: 1,
    surfaceStepScale: 1,
    lineAlpha: 0.64,
    maxChroma: 0.4,
    accentChromaScale: 2,
    semanticContrastRatio: 3,
    solidTone: 0.56,
    mutedAlpha: 0.16,
  },
  radius: '12px',
} as const;

function themeMode(bgBase: string, bgAccent: string): BrandThemeModeTokens {
  return {
    ...baseThemeTokens,
    bgBase,
    bgAccent,
    primitives: {
      'accent-500': {
        srgb: bgAccent,
        displayP3: bgAccent,
        oklch: bgAccent,
      },
    },
    semantic: {
      'bg-base': bgBase,
      'bg-accent': bgAccent,
    },
    displayP3: {
      'bg-base': bgBase,
      'bg-accent': bgAccent,
    },
    cssBindings: {
      'bg-base': bgBase,
      'bg-accent': 'var(--primitive-accent-500)',
    },
    displayP3CssBindings: {
      'bg-base': bgBase,
      'bg-accent': 'var(--primitive-accent-500)',
    },
  };
}

const defaultTheme = {
  defaultColorMode: 'dark',
  default: {
    id: 'default',
    label: 'Default',
    recipe: themeRecipe,
    swatch: {
      light: { background: '#F2F2ED', accent: '#3DA13D' },
      dark: { background: '#0B0B0F', accent: '#8AD87E' },
    },
    light: themeMode('#F2F2ED', '#3DA13D'),
    dark: themeMode('#0B0B0F', '#8AD87E'),
  },
} satisfies BrandThemeDefinition;

const canopyCore: BrandCore = {
  schemaVersion: 5,
  id: 'canopy',
  displayName: 'Canopy',
  shortName: 'Canopy',
  internalName: 'canopy',
  cliName: 'canopy',
  appId: 'com.canopy.ui',
  description: 'Canopy - Autonomous multi-agent orchestration framework',
  author: 'Canopy Team',
  serverDisplayName: 'Canopy Server',
  theme: defaultTheme,
  storage: {
    dataDirNames: {
      prod: ['.canopy', '.unstoppable-code'],
      rc: ['.canopy-rc', '.unstoppable-code-rc'],
      dev: ['.canopy-dev', '.unstoppable-code-dev'],
    },
    secureDataDirNames: {
      prod: '.canopy-secure',
      rc: '.canopy-rc-secure',
      internal: '.canopy-internal-secure',
      dev: '.canopy-secure-dev',
    },
    configFileNames: ['canopy.json', 'unstoppable-code.json'],
    projectConfigDirNames: ['.canopy', '.unstoppable-code'],
  },
  environment: { prefixes: ['CANOPY'] },
  tools: { namespace: 'canopy' },
  desktopIntegration: {
    routePrefix: '/canopy',
    tokenHeaderName: 'X-Canopy-Integration-Token',
    tokenEnvVar: 'CANOPY_DESKTOP_INTEGRATION_TOKEN',
  },
  dictation: {
    binaryName: 'canopy-dictate',
    bundleId: 'com.canopy.dictate',
    displayName: 'Canopy Dictate',
  },
  web: {
    hostnames: [],
    apiNamespace: 'desktop-app',
    wellKnownNamespace: 'canopy',
    title: 'canopy',
    description: 'Canopy Server',
  },
  release: { enabled: ['internal'], artifactPrefix: 'canopy' },
};

const someBrandCore: BrandCore = {
  ...canopyCore,
  id: 'somebrand',
  displayName: 'SomeBrand',
  shortName: 'SomeBrand',
  internalName: 'somebrand',
  cliName: 'somebrand',
  appId: 'com.somebrand.ui',
  description: 'SomeBrand product',
  author: 'SomeBrand Team',
  serverDisplayName: 'SomeBrand Server',
  storage: {
    dataDirNames: {
      prod: ['.somebrand', '.canopy'],
      rc: ['.somebrand-rc', '.canopy-rc'],
      dev: ['.somebrand-dev', '.canopy-dev'],
    },
    secureDataDirNames: {
      prod: '.somebrand-secure',
      rc: '.somebrand-rc-secure',
      internal: '.somebrand-internal-secure',
      dev: '.somebrand-secure-dev',
    },
    configFileNames: ['somebrand.json', 'canopy.json'],
    projectConfigDirNames: ['.somebrand', '.canopy'],
  },
  environment: { prefixes: ['SOMEBRAND', 'CANOPY'] },
  tools: { namespace: 'somebrand' },
  desktopIntegration: {
    routePrefix: '/somebrand',
    tokenHeaderName: 'X-SomeBrand-Integration-Token',
    tokenEnvVar: 'SOMEBRAND_DESKTOP_INTEGRATION_TOKEN',
  },
  dictation: {
    binaryName: 'somebrand-dictate',
    bundleId: 'com.somebrand.dictate',
    displayName: 'SomeBrand Dictate',
  },
  web: {
    hostnames: ['somebrand.example.com'],
    apiNamespace: 'desktop-app',
    wellKnownNamespace: 'somebrand',
    title: 'somebrand',
    description: 'SomeBrand Server',
  },
  release: {
    enabled: ['internal', 'rc', 'stable'],
    artifactPrefix: 'somebrand',
  },
};

// Just confirm a full BrandPackManifest using the core is assignable.
const _manifest: BrandPackManifest = {
  ...canopyCore,
  theme: {
    default: {
      id: 'default',
      label: 'Default',
      recipe: themeRecipe,
    },
  },
  assets: { logoSvg: './logo.svg', appIconPng: './icon.png' },
};
void _manifest;

// Confirm a DesktopBrandRuntime requires every asset slot.
const _desktopRuntime: DesktopBrandRuntime = {
  ...canopyCore,
  assets: {
    logoSvg: '<svg/>',
    logoSvgPath: '/abs/path/logo.svg',
    appIconPng: '/abs/path/icon.png',
    macIconIcns: '/abs/path/icon.icns',
    windowsIconIco: '/abs/path/icon.ico',
    linuxIconDir: '/abs/path/linux',
    webIconPng: '/abs/path/web-icon.png',
  },
};
void _desktopRuntime;

// Confirm a WebBrandRuntime requires every URL slot.
const _webRuntime: WebBrandRuntime = {
  ...canopyCore,
  assets: {
    logoSvgUrl: '/brand/canopy/logo.svg',
    logoSvgContent: '<svg/>',
    appIconPngUrl: '/brand/canopy/icon.png',
    webIconPngUrl: '/brand/canopy/web-icon.png',
  },
};
void _webRuntime;

// ---------------------------------------------------------------------------
// Default-Canopy contract values (section 2 of plan-transport.md)
// ---------------------------------------------------------------------------

describe('brand contract — default Canopy values', () => {
  it('matches the section-2 fixed contract values', () => {
    expect(canopyCore.displayName).toBe('Canopy');
    expect(canopyCore.shortName).toBe('Canopy');
    expect(canopyCore.internalName).toBe('canopy');
    expect(canopyCore.cliName).toBe('canopy');
    expect(canopyCore.appId).toBe('com.canopy.ui');
    expect(canopyCore.description).toBe(
      'Canopy - Autonomous multi-agent orchestration framework',
    );
    expect(canopyCore.author).toBe('Canopy Team');
    expect(canopyCore.serverDisplayName).toBe('Canopy Server');
    expect(canopyCore.theme.default.label).toBe('Default');
    expect(canopyCore.theme.default.light.bgAccent).toBe('#3DA13D');
    expect(canopyCore.theme.default.dark.bgAccent).toBe('#8AD87E');
    expect(canopyCore.storage.dataDirNames.prod).toEqual([
      '.canopy',
      '.unstoppable-code',
    ]);
    expect(canopyCore.storage.dataDirNames.rc).toEqual([
      '.canopy-rc',
      '.unstoppable-code-rc',
    ]);
    expect(canopyCore.storage.dataDirNames.dev).toEqual([
      '.canopy-dev',
      '.unstoppable-code-dev',
    ]);
    expect(canopyCore.storage.secureDataDirNames).toEqual({
      prod: '.canopy-secure',
      rc: '.canopy-rc-secure',
      internal: '.canopy-internal-secure',
      dev: '.canopy-secure-dev',
    });
    expect(canopyCore.storage.configFileNames).toEqual([
      'canopy.json',
      'unstoppable-code.json',
    ]);
    expect(canopyCore.storage.projectConfigDirNames).toEqual([
      '.canopy',
      '.unstoppable-code',
    ]);
    expect(canopyCore.environment.prefixes).toEqual(['CANOPY']);
    expect(canopyCore.tools.namespace).toBe('canopy');
    expect(canopyCore.desktopIntegration.routePrefix).toBe('/canopy');
    expect(canopyCore.desktopIntegration.tokenHeaderName).toBe(
      'X-Canopy-Integration-Token',
    );
    expect(canopyCore.desktopIntegration.tokenEnvVar).toBe(
      'CANOPY_DESKTOP_INTEGRATION_TOKEN',
    );
    expect(canopyCore.dictation.binaryName).toBe('canopy-dictate');
    expect(canopyCore.dictation.bundleId).toBe('com.canopy.dictate');
    expect(canopyCore.dictation.displayName).toBe('Canopy Dictate');
    expect(canopyCore.web.apiNamespace).toBe('desktop-app');
    expect(canopyCore.web.wellKnownNamespace).toBe('canopy');
    expect(canopyCore.web.title).toBe('canopy');
    expect(canopyCore.web.description).toBe('Canopy Server');
    expect(canopyCore.release.enabled).toEqual(['internal']);
    expect(canopyCore.release.artifactPrefix).toBe('canopy');
  });
});

// ---------------------------------------------------------------------------
// Builder contract values
// ---------------------------------------------------------------------------

describe('buildDesktopIntegrationRoutes', () => {
  it('derives the four canonical desktop-integration paths', () => {
    expect(buildDesktopIntegrationRoutes(canopyCore)).toEqual({
      routePrefix: '/canopy',
      mcpWorktreeSession: '/canopy/mcp/worktree-session',
      hooksClaudeTerminalWorktreeSession:
        '/canopy/hooks/claude-terminal/worktree-session',
      mcpProxy: '/canopy/mcp/proxy',
    });
  });

  it('derives branded paths for non-Canopy brands', () => {
    expect(buildDesktopIntegrationRoutes(someBrandCore)).toEqual({
      routePrefix: '/somebrand',
      mcpWorktreeSession: '/somebrand/mcp/worktree-session',
      hooksClaudeTerminalWorktreeSession:
        '/somebrand/hooks/claude-terminal/worktree-session',
      mcpProxy: '/somebrand/mcp/proxy',
    });
  });
});

describe('joinDesktopIntegrationRoute', () => {
  it('normalizes a missing leading slash on the tail', () => {
    expect(joinDesktopIntegrationRoute('/canopy', 'mcp/proxy')).toBe(
      '/canopy/mcp/proxy',
    );
  });

  it('normalizes a trailing slash on the prefix', () => {
    expect(joinDesktopIntegrationRoute('/canopy', '/mcp/proxy')).toBe(
      '/canopy/mcp/proxy',
    );
  });
});

describe('daemonName', () => {
  it('appends d to each shipped CLI name (Phase 0B D1)', () => {
    expect(daemonName({ cliName: 'canopy' })).toBe('canopyd');
    expect(daemonName({ cliName: 'unstoppable-code' })).toBe(
      'unstoppable-coded',
    );
  });
});

describe('buildInjectedToolNamesForBrand', () => {
  it('matches the default Canopy advertised tool names', () => {
    const names = buildInjectedToolNamesForBrand(canopyCore);
    expect(names.claude.askUserQuestion).toBe(
      'mcp__canopy_ui__AskUserQuestion',
    );
    expect(names.claude.getScriptOutput).toBe('mcp__canopy__GetScriptOutput');
    expect(names.claude.getGitPreferences).toBe(
      'mcp__canopy__GetGitPreferences',
    );
    expect(names.claude.readPipelineYaml).toBe('mcp__canopy__ReadPipelineYaml');
    expect(names.claude.showVisual).toBe('mcp__canopy__ShowVisual');
    expect(names.claude.previewVisual).toBe('mcp__canopy__PreviewVisual');
    expect(names.claude.watchGithubItems).toBe('mcp__canopy__WatchGitHubItems');
    expect(names.claude.getGithubPullRequestStatus).toBe(
      'mcp__canopy__GetGitHubPullRequestStatus',
    );
    expect(names.claude.deleteWatchers).toBe('mcp__canopy__DeleteWatchers');
    expect(names.claude.setAutoArchive).toBe('mcp__canopy__SetAutoArchive');
    expect(names.claude.setBaseBranch).toBe('mcp__canopy__SetBaseBranch');
    expect(names.claude.getCodeGraphContext).toBe(
      'mcp__canopy__GetCodeGraphContext',
    );
    expect(names.claude.buildOrUpdateCodeGraph).toBe(
      'mcp__canopy__BuildOrUpdateCodeGraph',
    );
    expect(names.claude.queryCodeGraph).toBe('mcp__canopy__QueryCodeGraph');
    expect(names.claude.searchCodeGraph).toBe('mcp__canopy__SearchCodeGraph');
    expect(names.claude.explainCodeSymbol).toBe(
      'mcp__canopy__ExplainCodeSymbol',
    );
    expect(names.claude.getImpactRadius).toBe('mcp__canopy__GetImpactRadius');
    expect(names.claude.detectChangedSymbols).toBe(
      'mcp__canopy__DetectChangedSymbols',
    );
    expect(names.claude.compareChangeImpact).toBe(
      'mcp__canopy__CompareChangeImpact',
    );
    expect(names.claude.getReviewContext).toBe('mcp__canopy__GetReviewContext');
    expect(names.codex.askUserQuestion).toBe('canopy_ask_user_question');
    expect(names.codex.getScriptOutput).toBe('canopy_get_script_output');
    expect(names.codex.getGitPreferences).toBe('canopy_get_git_preferences');
    expect(names.codex.readPipelineYaml).toBe('canopy_read_pipeline_yaml');
    expect(names.codex.showVisual).toBe('canopy_show_visual');
    expect(names.codex.previewVisual).toBe('canopy_preview_visual');
    expect(names.codex.deleteWatchers).toBe('canopy_delete_watchers');
    expect(names.codex.setAutoArchive).toBe('canopy_set_auto_archive');
    expect(names.codex.setBaseBranch).toBe('canopy_set_base_branch');
    expect(names.codex.getCodeGraphContext).toBe(
      'canopy_get_code_graph_context',
    );
    expect(names.codex.buildOrUpdateCodeGraph).toBe(
      'canopy_build_or_update_code_graph',
    );
    expect(names.codex.queryCodeGraph).toBe('canopy_query_code_graph');
    expect(names.codex.searchCodeGraph).toBe('canopy_search_code_graph');
    expect(names.codex.explainCodeSymbol).toBe('canopy_explain_code_symbol');
    expect(names.codex.getImpactRadius).toBe('canopy_get_impact_radius');
    expect(names.codex.detectChangedSymbols).toBe(
      'canopy_detect_changed_symbols',
    );
    expect(names.codex.compareChangeImpact).toBe(
      'canopy_compare_change_impact',
    );
    expect(names.codex.getReviewContext).toBe('canopy_get_review_context');
    expect(names.appAdvisor.claudeNamespacePrefix).toBe(
      'mcp__canopy_app_advisor__',
    );
    expect(names.appAdvisor.codexNamespacePrefix).toBe('canopy_app_advisor_');
  });

  it('rebrands the namespace for non-Canopy brands', () => {
    const names = buildInjectedToolNamesForBrand(someBrandCore);
    expect(names.claude.askUserQuestion).toBe(
      'mcp__somebrand_ui__AskUserQuestion',
    );
    expect(names.codex.getScriptOutput).toBe('somebrand_get_script_output');
    expect(names.codex.getGitPreferences).toBe('somebrand_get_git_preferences');
    expect(names.codex.readPipelineYaml).toBe('somebrand_read_pipeline_yaml');
    expect(names.claude.showVisual).toBe('mcp__somebrand__ShowVisual');
    expect(names.claude.previewVisual).toBe('mcp__somebrand__PreviewVisual');
    expect(names.codex.showVisual).toBe('somebrand_show_visual');
    expect(names.codex.previewVisual).toBe('somebrand_preview_visual');
    expect(names.codex.watchGithubItems).toBe('somebrand_watch_github_items');
    expect(names.codex.getGithubPullRequestStatus).toBe(
      'somebrand_get_github_pull_request_status',
    );
    expect(names.codex.deleteWatchers).toBe('somebrand_delete_watchers');
    expect(names.claude.watchGithubItems).toBe(
      'mcp__somebrand__WatchGitHubItems',
    );
    expect(names.claude.deleteWatchers).toBe('mcp__somebrand__DeleteWatchers');
    expect(names.codex.setAutoArchive).toBe('somebrand_set_auto_archive');
    expect(names.codex.setBaseBranch).toBe('somebrand_set_base_branch');
    expect(names.claude.setBaseBranch).toBe('mcp__somebrand__SetBaseBranch');
    expect(names.claude.getCodeGraphContext).toBe(
      'mcp__somebrand__GetCodeGraphContext',
    );
    expect(names.codex.queryCodeGraph).toBe('somebrand_query_code_graph');
    expect(names.codex.searchCodeGraph).toBe('somebrand_search_code_graph');
    expect(names.codex.explainCodeSymbol).toBe('somebrand_explain_code_symbol');
    expect(names.codex.getImpactRadius).toBe('somebrand_get_impact_radius');
    expect(names.codex.detectChangedSymbols).toBe(
      'somebrand_detect_changed_symbols',
    );
    expect(names.codex.compareChangeImpact).toBe(
      'somebrand_compare_change_impact',
    );
    expect(names.codex.getReviewContext).toBe('somebrand_get_review_context');
    expect(names.appAdvisor.claudeNamespacePrefix).toBe(
      'mcp__somebrand_app_advisor__',
    );
    // The advertised set MUST NOT include legacy canopy_* / mcp__canopy__*.
    const all = [
      names.claude.askUserQuestion,
      names.claude.getScriptOutput,
      names.claude.getGitPreferences,
      names.claude.readPipelineYaml,
      names.claude.watchGithubItems,
      names.claude.getGithubPullRequestStatus,
      names.claude.setAutoArchive,
      names.claude.setBaseBranch,
      names.claude.getCodeGraphContext,
      names.claude.buildOrUpdateCodeGraph,
      names.claude.queryCodeGraph,
      names.claude.searchCodeGraph,
      names.claude.explainCodeSymbol,
      names.claude.getImpactRadius,
      names.claude.detectChangedSymbols,
      names.claude.compareChangeImpact,
      names.claude.getReviewContext,
      names.codex.askUserQuestion,
      names.codex.getScriptOutput,
      names.codex.getGitPreferences,
      names.codex.readPipelineYaml,
      names.codex.watchGithubItems,
      names.codex.getGithubPullRequestStatus,
      names.codex.setAutoArchive,
      names.codex.setBaseBranch,
      names.codex.getCodeGraphContext,
      names.codex.buildOrUpdateCodeGraph,
      names.codex.queryCodeGraph,
      names.codex.searchCodeGraph,
      names.codex.explainCodeSymbol,
      names.codex.getImpactRadius,
      names.codex.detectChangedSymbols,
      names.codex.compareChangeImpact,
      names.codex.getReviewContext,
      names.appAdvisor.claudeNamespacePrefix,
      names.appAdvisor.codexNamespacePrefix,
    ];
    for (const name of all) {
      expect(name.toLowerCase()).not.toContain('canopy');
    }
  });
});

describe('buildBrandPathPrefix', () => {
  it('builds /api/v1/<namespace> and /.well-known/<namespace>', () => {
    expect(buildBrandPathPrefix(canopyCore)).toEqual({
      api: '/api/v1/desktop-app',
      wellKnown: '/.well-known/canopy',
    });
    expect(buildBrandPathPrefix(someBrandCore)).toEqual({
      api: '/api/v1/desktop-app',
      wellKnown: '/.well-known/somebrand',
    });
  });
});

describe('buildBrandDefaultThemeCss', () => {
  it('emits default-theme selectors that do not override named themes', () => {
    const css = buildBrandDefaultThemeCss(canopyCore.theme.default);
    expect(css).toContain(':root:not([data-theme]) {');
    expect(css).toContain(':root:not([data-theme]).dark {');
    expect(css).toContain('--primitive-accent-500: #3DA13D;');
    expect(css).toContain('--primitive-accent-500: #8AD87E;');
    expect(css).toContain('--bg-accent: var(--primitive-accent-500);');
  });
});

describe('dedupePreserveOrder', () => {
  it('keeps first occurrence and drops later duplicates', () => {
    expect(dedupePreserveOrder(['a', 'b', 'a', 'c', 'b'])).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

// ---------------------------------------------------------------------------
// validateBrandCore
// ---------------------------------------------------------------------------

describe('validateBrandCore', () => {
  it('accepts a well-formed Canopy core', () => {
    expect(validateBrandCore(canopyCore, 'canopy').ok).toBe(true);
  });

  it('accepts a manifest without a copilot block', () => {
    const { copilot: _omitted, ...withoutCopilot } = canopyCore;
    void _omitted;
    expect(validateBrandCore(withoutCopilot, 'canopy').ok).toBe(true);
  });

  it('flags an empty copilot.gitHubAppClientId', () => {
    const result = validateBrandCore(
      { ...canopyCore, copilot: { gitHubAppClientId: '' } },
      'canopy',
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'copilot.gitHubAppClientId must be a non-empty string',
    );
  });

  it('flags a copilot block that is not an object', () => {
    const result = validateBrandCore(
      { ...canopyCore, copilot: 'Iv23li' },
      'canopy',
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('copilot must be an object when provided');
  });

  it('flags id ≠ directory name', () => {
    const result = validateBrandCore(canopyCore, 'somewhere-else');
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('directory name'))).toBe(true);
  });

  it('flags unsupported schemaVersion', () => {
    const result = validateBrandCore({ ...canopyCore, schemaVersion: 1 });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('schemaVersion'))).toBe(true);
  });

  it('flags missing default theme tokens', () => {
    const result = validateBrandCore({
      ...canopyCore,
      theme: {
        default: {
          ...canopyCore.theme.default,
          light: { ...canopyCore.theme.default.light, bgAccent: '' },
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes('theme.default.light.bgAccent')),
    ).toBe(true);
  });

  it.each(['light', 'dark', 'system'] as const)(
    'accepts %s as the brand default color mode',
    (defaultColorMode) => {
      const result = validateBrandCore({
        ...canopyCore,
        theme: { ...canopyCore.theme, defaultColorMode },
      });

      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    },
  );

  it('flags an unsupported brand default color mode', () => {
    const result = validateBrandCore({
      ...canopyCore,
      theme: { ...canopyCore.theme, defaultColorMode: 'sepia' },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'theme.defaultColorMode must be one of light, dark, system',
    );
  });

  it('flags non-UPPER_SNAKE env prefix', () => {
    const result = validateBrandCore({
      ...canopyCore,
      environment: { prefixes: ['canopy'] },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('environment.prefixes'))).toBe(
      true,
    );
  });

  it('flags duplicate fallback entries before runtime dedupe can hide them', () => {
    const result = validateBrandCore({
      ...someBrandCore,
      storage: {
        ...someBrandCore.storage,
        dataDirNames: {
          prod: ['.somebrand', '.canopy', '.canopy'],
          rc: ['.somebrand-rc', '.canopy-rc'],
          dev: ['.somebrand-dev', '.canopy-dev'],
        },
        configFileNames: ['somebrand.json', 'canopy.json', 'canopy.json'],
        projectConfigDirNames: ['.somebrand', '.canopy', '.canopy'],
      },
      environment: { prefixes: ['SOMEBRAND', 'CANOPY', 'CANOPY'] },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'storage.dataDirNames.prod must not contain duplicate entries',
        'storage.configFileNames must not contain duplicate entries',
        'storage.projectConfigDirNames must not contain duplicate entries',
        'environment.prefixes must not contain duplicate entries',
      ]),
    );
  });

  it('accepts storage without explicit rc entries', () => {
    const result = validateBrandCore({
      ...someBrandCore,
      storage: {
        ...someBrandCore.storage,
        dataDirNames: {
          prod: someBrandCore.storage.dataDirNames.prod,
          dev: someBrandCore.storage.dataDirNames.dev,
        },
        secureDataDirNames: {
          prod: someBrandCore.storage.secureDataDirNames.prod,
          internal: someBrandCore.storage.secureDataDirNames.internal,
          dev: someBrandCore.storage.secureDataDirNames.dev,
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it('rejects storage without an explicit internal secure directory', () => {
    const result = validateBrandCore({
      ...someBrandCore,
      storage: {
        ...someBrandCore.storage,
        secureDataDirNames: {
          prod: someBrandCore.storage.secureDataDirNames.prod,
          rc: someBrandCore.storage.secureDataDirNames.rc,
          dev: someBrandCore.storage.secureDataDirNames.dev,
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'storage.secureDataDirNames.internal must be a directory name, not a path',
    );
  });

  it('flags secure data directory names that are paths or traversal segments', () => {
    const result = validateBrandCore({
      ...canopyCore,
      storage: {
        ...canopyCore.storage,
        secureDataDirNames: {
          prod: '../canopy-secure',
          rc: '.somebrand-rc-secure',
          internal: '..',
          dev: ' .. ',
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'storage.secureDataDirNames.prod must be a directory name, not a path',
        'storage.secureDataDirNames.internal must be a directory name, not a path',
        'storage.secureDataDirNames.dev must be a directory name, not a path',
      ]),
    );
  });

  it('flags routePrefix without leading slash', () => {
    const result = validateBrandCore({
      ...canopyCore,
      desktopIntegration: {
        ...canopyCore.desktopIntegration,
        routePrefix: 'canopy' as `/${string}`,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('routePrefix'))).toBe(true);
  });

  it('rejects non-object input', () => {
    expect(validateBrandCore(null).ok).toBe(false);
    expect(validateBrandCore('canopy').ok).toBe(false);
    expect(validateBrandCore([]).ok).toBe(false);
  });

  it('accepts web.mobileApps with both store URLs', () => {
    const result = validateBrandCore({
      ...someBrandCore,
      web: {
        ...someBrandCore.web,
        mobileApps: {
          appStoreUrl:
            'https://apps.apple.com/us/app/unstoppable-ai/id6786961568',
          playStoreUrl:
            'https://play.google.com/store/apps/details?id=com.unstoppabledomains.canopy',
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts web.mobileApps with a single store URL', () => {
    const result = validateBrandCore({
      ...someBrandCore,
      web: {
        ...someBrandCore.web,
        mobileApps: { appStoreUrl: 'https://apps.apple.com/us/app/x/id1' },
      },
    });
    expect(result.ok).toBe(true);
  });

  it('flags a non-https web.mobileApps store URL', () => {
    const result = validateBrandCore({
      ...someBrandCore,
      web: {
        ...someBrandCore.web,
        mobileApps: { appStoreUrl: 'http://apps.apple.com/us/app/x/id1' },
      },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes('web.mobileApps.appStoreUrl')),
    ).toBe(true);
  });

  it('flags an empty web.mobileApps object', () => {
    const result = validateBrandCore({
      ...someBrandCore,
      web: { ...someBrandCore.web, mobileApps: {} },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes('at least one store URL')),
    ).toBe(true);
  });
});

describe('Linux packaging metadata', () => {
  it('accepts omitted and declared contacts without a schema bump', () => {
    expect(validateBrandCore(canopyCore).ok).toBe(true);
    expect(
      validateBrandCore({
        ...canopyCore,
        linux: { maintainerEmail: 'support@example.com' },
      }).ok,
    ).toBe(true);
  });
  it.each([
    null,
    [],
    {},
    { maintainerEmail: '' },
    { maintainerEmail: ' ' },
    { maintainerEmail: 'bad' },
    { maintainerEmail: 'a@example.com ' },
    { maintainerEmail: 'a\u0000@example.com' },
    { maintainerEmail: 'a\u0085@example.com' },
  ])('rejects invalid Linux metadata %j', (linux) => {
    const result = validateBrandCore({ ...canopyCore, linux });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('linux'))).toBe(true);
  });
});
