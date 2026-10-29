import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

let configured = false;

function configureStandaloneTypeScript(): void {
  // File tabs do not run a workspace TypeScript project service. Semantic
  // checks need tsconfig selection, path aliases, node_modules/@types, and
  // sibling source files, so they produce false errors in standalone models.
  const diagnosticsOptions: monaco.typescript.DiagnosticsOptions = {
    noSemanticValidation: true,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: true,
  };
  const modeConfiguration: monaco.typescript.ModeConfiguration = {
    completionItems: false,
    hovers: false,
    documentSymbols: false,
    definitions: false,
    references: false,
    documentHighlights: false,
    rename: false,
    diagnostics: true,
    documentRangeFormattingEdits: false,
    signatureHelp: false,
    onTypeFormattingEdits: false,
    codeActions: false,
    inlayHints: false,
  };

  monaco.typescript.typescriptDefaults.setDiagnosticsOptions(
    diagnosticsOptions,
  );
  monaco.typescript.javascriptDefaults.setDiagnosticsOptions(
    diagnosticsOptions,
  );
  monaco.typescript.typescriptDefaults.setModeConfiguration(modeConfiguration);
  monaco.typescript.javascriptDefaults.setModeConfiguration(modeConfiguration);
}

function configureStandaloneJson(): void {
  // JSON syntax validation is local and useful. External schema discovery is
  // not: file tabs have no schema registry and should not fetch remote schemas
  // just because a random workspace file happens to match a convention.
  const diagnosticsOptions: monaco.json.DiagnosticsOptions = {
    validate: true,
    schemas: [],
    enableSchemaRequest: false,
    schemaValidation: 'ignore',
    schemaRequest: 'ignore',
  };
  const modeConfiguration: monaco.json.ModeConfiguration = {
    documentFormattingEdits: false,
    documentRangeFormattingEdits: false,
    completionItems: false,
    hovers: false,
    documentSymbols: false,
    tokens: true,
    colors: false,
    foldingRanges: false,
    diagnostics: true,
    selectionRanges: false,
  };

  monaco.json.jsonDefaults.setDiagnosticsOptions(diagnosticsOptions);
  monaco.json.jsonDefaults.setModeConfiguration(modeConfiguration);
}

function configureStandaloneCss(): void {
  // CSS/SCSS/LESS diagnostics are lint-style language-service checks, not
  // tokenization. Disable those richer services while keeping highlighting.
  const options: monaco.css.Options = { validate: false };
  const modeConfiguration: monaco.css.ModeConfiguration = {
    completionItems: false,
    hovers: false,
    documentSymbols: false,
    definitions: false,
    references: false,
    documentHighlights: false,
    rename: false,
    colors: false,
    foldingRanges: false,
    diagnostics: false,
    selectionRanges: false,
    documentFormattingEdits: false,
    documentRangeFormattingEdits: false,
  };
  const defaults: monaco.css.LanguageServiceDefaults[] = [
    monaco.css.cssDefaults,
    monaco.css.scssDefaults,
    monaco.css.lessDefaults,
  ];

  for (const languageDefaults of defaults) {
    languageDefaults.setOptions(options);
    languageDefaults.setModeConfiguration(modeConfiguration);
  }
}

function configureStandaloneHtml(): void {
  // HTML-family language services can provide completions, links, document
  // symbols, and diagnostics. In file tabs those services do not have app
  // context, so keep the tokenizer and turn off the richer providers.
  const modeConfiguration: monaco.html.ModeConfiguration = {
    completionItems: false,
    hovers: false,
    documentSymbols: false,
    links: false,
    documentHighlights: false,
    rename: false,
    colors: false,
    foldingRanges: false,
    diagnostics: false,
    selectionRanges: false,
    documentFormattingEdits: false,
    documentRangeFormattingEdits: false,
  };
  const defaults: monaco.html.LanguageServiceDefaults[] = [
    monaco.html.htmlDefaults,
    monaco.html.handlebarDefaults,
    monaco.html.razorDefaults,
  ];

  for (const languageDefaults of defaults) {
    languageDefaults.setModeConfiguration(modeConfiguration);
  }
}

function configureStandaloneLanguageServices(): void {
  configureStandaloneTypeScript();
  configureStandaloneJson();
  configureStandaloneCss();
  configureStandaloneHtml();
}

/**
 * Configure `@monaco-editor/react` to use the locally bundled `monaco-editor`
 * package instead of the default CDN loader. Electron renderers typically
 * disallow remote scripts via CSP, so the CDN path would fail in production.
 *
 * Safe to call multiple times — subsequent invocations are no-ops.
 */
export function configureMonaco(): void {
  if (configured) return;
  configured = true;

  // Monaco picks workers up off `self.MonacoEnvironment.getWorker(...)`.
  // We bundle the workers via Vite's `?worker` import suffix and route the
  // language label to the matching worker. Anything we don't have a
  // dedicated worker for falls back to the generic editor worker.
  const monacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case 'json':
          return new jsonWorker();
        case 'css':
        case 'scss':
        case 'less':
          return new cssWorker();
        case 'html':
        case 'handlebars':
        case 'razor':
          return new htmlWorker();
        case 'typescript':
        case 'javascript':
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };

  // Attach to the global object so Monaco's worker bootstrap finds it.
  globalThis.MonacoEnvironment = monacoEnvironment;

  loader.config({ monaco });
  configureStandaloneLanguageServices();
}
