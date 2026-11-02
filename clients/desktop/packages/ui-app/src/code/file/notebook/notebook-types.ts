/**
 * Typed, display-ready model of a Jupyter notebook (nbformat v4) for the
 * read-only notebook preview. The parser normalizes multiline fields
 * (`string | string[]`) to one string and removes ANSI escape codes from
 * stream text and tracebacks, so the view never sees raw nbformat JSON.
 */

/**
 * One output's MIME bundle. Values are normalized to strings; non-string
 * payloads (for example `application/json` objects) are dropped.
 */
export type NotebookMimeBundle = Readonly<Record<string, string>>;

export type NotebookOutput =
  | {
      readonly outputType: 'stream';
      readonly name: 'stdout' | 'stderr';
      readonly text: string;
    }
  | {
      readonly outputType: 'error';
      readonly ename: string;
      readonly evalue: string;
      /** Traceback lines joined with `\n`, ANSI escape codes removed. */
      readonly traceback: string;
    }
  | {
      readonly outputType: 'execute_result';
      readonly executionCount: number | null;
      readonly data: NotebookMimeBundle;
    }
  | {
      readonly outputType: 'display_data';
      readonly data: NotebookMimeBundle;
    };

export type NotebookCell =
  | {
      readonly cellType: 'markdown';
      readonly source: string;
      /**
       * Images from the cell's nbformat `attachments`, by name, as validated
       * `data:` URLs for `![](attachment:<name>)`. Absent when there are none.
       */
      readonly attachments?: ReadonlyMap<string, string>;
    }
  | { readonly cellType: 'raw'; readonly source: string }
  | {
      readonly cellType: 'code';
      readonly source: string;
      readonly executionCount: number | null;
      readonly outputs: readonly NotebookOutput[];
    };

export interface ParsedNotebook {
  /**
   * Language of code cells, from `metadata.language_info.name`, else
   * `metadata.kernelspec.language`; `null` when neither is a non-empty string.
   */
  readonly language: string | null;
  readonly cells: readonly NotebookCell[];
}

export type NotebookParseFailure =
  /** The content is not valid JSON. */
  | 'invalid-json'
  /** Valid JSON, but `nbformat` is missing or not 4. */
  | 'unsupported-version'
  /** nbformat 4, but the top level or `cells` has the wrong shape. */
  | 'invalid-structure';

export type NotebookParseResult =
  | { readonly status: 'ok'; readonly notebook: ParsedNotebook }
  | { readonly status: 'failed'; readonly reason: NotebookParseFailure };
