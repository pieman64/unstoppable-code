import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

const ENTRY_PATH = '/browser-lab/upload';
const FRAME_PATH = '/browser-lab/upload/frame';
/** A cross-origin frame that fills a drop zone of the page and takes drops itself. */
const DROP_FRAME_PATH = '/browser-lab/upload/drop-frame';
const ECHO_PATH = '/browser-lab/upload-echo';
const UPLOAD_SCRIPT = `(() => {
  'use strict';
  const uploadEndpoint = '/browser-lab/upload-echo';
  const setState = (output, state, fileCount) => {
    output.dataset.browserLabState = state;
    output.dataset.browserLabFileCount = String(fileCount);
  };
  const sendFiles = async (files, output) => {
    const selected = Array.from(files || []);
    setState(output, 'uploading', selected.length);
    const formData = new FormData();
    for (const file of selected) formData.append('files', file, file.name);
    try {
      const response = await fetch(uploadEndpoint, { method: 'POST', body: formData });
      const result = await response.json();
      output.textContent = JSON.stringify(result);
      setState(output, response.ok ? 'done' : 'error', selected.length);
    } catch {
      output.textContent = 'Upload failed.';
      setState(output, 'error', selected.length);
    }
  };
  for (const input of document.querySelectorAll('input[type="file"][data-result-id]')) {
    const output = document.getElementById(input.dataset.resultId);
    if (output) input.addEventListener('change', () => sendFiles(input.files, output));
  }
  const hiddenInput = document.getElementById('hidden-upload-input');
  const openButton = document.getElementById('hidden-upload-open');
  if (hiddenInput && openButton) openButton.addEventListener('click', () => hiddenInput.click());
  const dropZone = document.getElementById('upload-drop-zone');
  const dropResult = document.getElementById('upload-drop-result');
  if (dropZone && dropResult) {
    dropZone.addEventListener('dragover', (event) => event.preventDefault());
    dropZone.addEventListener('drop', (event) => {
      event.preventDefault();
      sendFiles(event.dataTransfer && event.dataTransfer.files, dropResult);
    });
  }
})();`;

const BOUNDARY_MARKER_PREFIX = Buffer.from('\r\n--');
const CRLF = Buffer.from('\r\n');
const HEADER_SEPARATOR = Buffer.from('\r\n\r\n');
const BOUNDARY_PARAMETER_CHARS = /^[0-9A-Za-z'()+_,\-./:=? ]+$/;

export const interactionCase = {
  id: 'upload',
  kind: 'interaction',
  title: 'File upload',
  entryPath: ENTRY_PATH,
  pages: [
    {
      path: ENTRY_PATH,
      controls: [
        'browser-lab-upload-main',
        'browser-lab-upload-single-form',
        'browser-lab-upload-single-input',
        'browser-lab-upload-single-submit',
        'browser-lab-upload-single-result',
        'browser-lab-upload-multiple-input',
        'browser-lab-upload-multiple-result',
        'browser-lab-upload-image-input',
        'browser-lab-upload-image-result',
        'browser-lab-upload-hidden-open',
        'browser-lab-upload-hidden-input',
        'browser-lab-upload-hidden-result',
        'browser-lab-upload-drop-zone',
        'browser-lab-upload-drop-result',
        'browser-lab-upload-framed-drop-zone',
        'browser-lab-upload-cross-origin-frame',
      ],
    },
    {
      path: DROP_FRAME_PATH,
      controls: [
        'browser-lab-upload-drop-frame-zone',
        'browser-lab-upload-drop-frame-result',
      ],
    },
    {
      path: FRAME_PATH,
      controls: [
        'browser-lab-upload-frame-main',
        'browser-lab-upload-frame-form',
        'browser-lab-upload-frame-input',
        'browser-lab-upload-frame-submit',
        'browser-lab-upload-frame-result',
      ],
    },
  ],
  endpoints: [ECHO_PATH],
};

function splitParameters(value) {
  const parameters = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (quoted && character === '\\') {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ';' && !quoted) {
      parameters.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted || escaped) return null;
  parameters.push(value.slice(start).trim());
  return parameters;
}

function readQuotedValue(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(trimmed)) return null;
    return trimmed;
  }
  if (trimmed.length < 2 || !trimmed.endsWith('"')) return null;
  let decoded = '';
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const character = trimmed[index];
    if (character === '\\') {
      index += 1;
      if (index >= trimmed.length - 1) return null;
      decoded += trimmed[index];
    } else if (character === '"' || character === '\r' || character === '\n') {
      return null;
    } else {
      decoded += character;
    }
  }
  return decoded;
}

function parseBoundary(contentType) {
  const raw = String(contentType ?? '').trim();
  const firstSeparator = raw.indexOf(';');
  const mediaType = (firstSeparator === -1 ? raw : raw.slice(0, firstSeparator))
    .trim()
    .toLowerCase();
  if (mediaType !== 'multipart/form-data') return { error: 415 };
  if (firstSeparator === -1) return { error: 415 };
  const parameters = splitParameters(raw.slice(firstSeparator + 1));
  if (!parameters) return { error: 400 };
  let boundary;
  for (const parameter of parameters) {
    if (!parameter) continue;
    const separator = parameter.indexOf('=');
    const name = (separator <= 0 ? parameter : parameter.slice(0, separator))
      .trim()
      .toLowerCase();
    if (name !== 'boundary') continue;
    if (separator <= 0) return { error: 400 };
    if (boundary !== undefined) return { error: 400 };
    boundary = readQuotedValue(parameter.slice(separator + 1));
    if (boundary === null) return { error: 400 };
  }
  if (boundary === undefined) return { error: 415 };
  if (
    boundary.length < 1 ||
    boundary.length > 70 ||
    boundary.endsWith(' ') ||
    !BOUNDARY_PARAMETER_CHARS.test(boundary)
  ) {
    return { error: 400 };
  }
  return { boundary };
}

function parsePartHeaders(headerBytes) {
  let headerText;
  try {
    headerText = new TextDecoder('utf-8', { fatal: true }).decode(headerBytes);
  } catch {
    return null;
  }
  if (/\r(?!\n)|(?<!\r)\n/.test(headerText)) return null;
  const headers = new Map();
  for (const line of headerText.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) return null;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return null;
    const normalizedName = name.toLowerCase();
    if (headers.has(normalizedName)) return null;
    headers.set(normalizedName, value);
  }
  const disposition = headers.get('content-disposition');
  if (!disposition) return null;
  const parameters = splitParameters(disposition);
  if (
    !parameters ||
    parameters.length === 0 ||
    parameters[0].toLowerCase() !== 'form-data'
  ) {
    return null;
  }
  const values = new Map();
  for (const parameter of parameters.slice(1)) {
    if (!parameter) continue;
    const separator = parameter.indexOf('=');
    if (separator <= 0) return null;
    const name = parameter.slice(0, separator).trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || values.has(name)) {
      return null;
    }
    const value = readQuotedValue(parameter.slice(separator + 1));
    if (value === null) return null;
    values.set(name, value);
  }
  if (!values.has('name') || values.get('name') === '') return null;
  return { filename: values.has('filename') ? values.get('filename') : null };
}

function findDelimiter(body, from, delimiter) {
  let start = body.indexOf(delimiter, from);
  while (start !== -1) {
    const suffix = start + delimiter.length;
    if (
      (body[suffix] === 45 && body[suffix + 1] === 45) ||
      (body[suffix] === 13 && body[suffix + 1] === 10)
    ) {
      return { start, suffix };
    }
    start = body.indexOf(delimiter, start + 1);
  }
  return null;
}

function parseMultipart(body, boundary, limits) {
  const opening = Buffer.from(`--${boundary}`, 'ascii');
  if (
    body.length < opening.length ||
    !body.subarray(0, opening.length).equals(opening)
  ) {
    return { error: 'The multipart body is malformed.' };
  }
  let cursor = opening.length;
  if (body[cursor] === 45 && body[cursor + 1] === 45) {
    return { files: [] };
  }
  if (!body.subarray(cursor, cursor + 2).equals(CRLF)) {
    return { error: 'The multipart body is malformed.' };
  }
  cursor += 2;
  const delimiter = Buffer.concat([
    BOUNDARY_MARKER_PREFIX,
    opening.subarray(2),
  ]);
  const files = [];
  let partCount = 0;
  while (cursor <= body.length) {
    const headerEnd = body.indexOf(HEADER_SEPARATOR, cursor);
    if (headerEnd === -1) return { error: 'The multipart body is malformed.' };
    if (headerEnd - cursor > limits.maxUploadPartHeaderBytes) {
      return { error: 'A multipart part header block is too large.' };
    }
    const parsedHeaders = parsePartHeaders(body.subarray(cursor, headerEnd));
    if (!parsedHeaders)
      return { error: 'A multipart part has invalid headers.' };
    partCount += 1;
    if (partCount > limits.maxUploadParts) {
      return { error: 'Too many multipart parts.' };
    }
    const partStart = headerEnd + HEADER_SEPARATOR.length;
    const next = findDelimiter(body, partStart, delimiter);
    if (!next) return { error: 'The multipart body has no closing delimiter.' };
    const content = body.subarray(partStart, next.start);
    if (parsedHeaders.filename !== null && parsedHeaders.filename !== '') {
      if (
        Buffer.byteLength(parsedHeaders.filename, 'utf8') >
        limits.maxUploadFileNameBytes
      ) {
        return { error: 'An uploaded file name is too long.' };
      }
      files.push({
        name: parsedHeaders.filename,
        size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    }
    if (body[next.suffix] === 45 && body[next.suffix + 1] === 45) {
      return { files };
    }
    cursor = next.suffix + 2;
  }
  return { error: 'The multipart body has no closing delimiter.' };
}

function uploadEchoRoute(kit, limits) {
  return {
    kind: 'json',
    methods: {
      POST: async (context) => {
        const parsedBoundary = parseBoundary(
          context.request.headers['content-type'],
        );
        if (parsedBoundary.error) {
          kit.discardBody(context.request);
          const status = parsedBoundary.error;
          return kit.sendRouteError(
            context,
            status,
            status === 415
              ? 'Submit this endpoint as multipart/form-data with a boundary.'
              : 'The multipart boundary is malformed.',
          );
        }
        const declaredLength = Number(
          context.request.headers['content-length'],
        );
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > limits.maxUploadBodyBytes
        ) {
          kit.discardBody(context.request);
          return kit.sendRouteError(
            context,
            413,
            'The uploaded body is too large.',
          );
        }
        const read = await kit.readBody(
          context.request,
          limits.maxUploadBodyBytes,
        );
        if (read.tooLarge) {
          return kit.sendRouteError(
            context,
            413,
            'The uploaded body is too large.',
          );
        }
        if (read.failed) {
          return kit.sendRouteError(
            context,
            400,
            'The multipart body could not be read.',
          );
        }
        const result = parseMultipart(
          read.body,
          parsedBoundary.boundary,
          limits,
        );
        if (result.error) return kit.sendRouteError(context, 400, result.error);
        return kit.sendJson(context.response, 200, { files: result.files });
      },
    },
  };
}

export function createRoutes(kit) {
  const { html } = kit;
  const resultOutput = (id, testId) =>
    html`<output
      id="${id}"
      data-testid="${testId}"
      data-browser-lab-state="idle"
      data-browser-lab-file-count="0"
      >No upload yet.</output
    >`;
  const fileInput = ({
    id,
    testId,
    label,
    accept,
    multiple = false,
    hidden = false,
    resultId,
    resultTestId,
  }) =>
    html` <label for="${id}">${label}</label>
      <input
        id="${id}"
        type="file"
        name="files"
        ${accept ? html`accept="${accept}"` : ''}
        ${multiple ? kit.trusted('multiple') : ''}
        ${hidden ? kit.trusted('hidden') : ''}
        data-result-id="${resultId}"
        data-testid="${testId}"
      />
      ${resultOutput(resultId, resultTestId)}`;

  const renderMain = (context) => {
    const paired = kit.pairedOriginFor(context);
    if (paired.error) {
      kit.sendRouteError(context, 500, paired.error);
      return null;
    }
    return kit.renderInteractionPage({
      caseDef: interactionCase,
      scripts: [UPLOAD_SCRIPT],
      csp: { frameSources: [paired.origin] },
      main: html`<main data-testid="browser-lab-upload-main">
        <h1>${interactionCase.title}</h1>
        <section aria-labelledby="single-upload-title">
          <h2 id="single-upload-title">Single file</h2>
          <form
            method="post"
            action="${ECHO_PATH}"
            enctype="multipart/form-data"
            data-testid="browser-lab-upload-single-form"
          >
            ${fileInput({
              id: 'single-upload-input',
              testId: 'browser-lab-upload-single-input',
              label: 'Choose one file',
              resultId: 'single-upload-result',
              resultTestId: 'browser-lab-upload-single-result',
            })}
            <button
              type="submit"
              data-testid="browser-lab-upload-single-submit"
            >
              Upload file
            </button>
          </form>
        </section>
        <section aria-labelledby="multiple-upload-title">
          <h2 id="multiple-upload-title">Multiple files</h2>
          ${fileInput({
            id: 'multiple-upload-input',
            testId: 'browser-lab-upload-multiple-input',
            label: 'Choose multiple files',
            multiple: true,
            resultId: 'multiple-upload-result',
            resultTestId: 'browser-lab-upload-multiple-result',
          })}
        </section>
        <section aria-labelledby="image-upload-title">
          <h2 id="image-upload-title">Image-only chooser hint</h2>
          ${fileInput({
            id: 'image-upload-input',
            testId: 'browser-lab-upload-image-input',
            label: 'Choose a PNG image',
            accept: 'image/png',
            resultId: 'image-upload-result',
            resultTestId: 'browser-lab-upload-image-result',
          })}
        </section>
        <section aria-labelledby="hidden-upload-title">
          <h2 id="hidden-upload-title">Button-opened chooser</h2>
          <button
            id="hidden-upload-open"
            type="button"
            data-testid="browser-lab-upload-hidden-open"
          >
            Choose a hidden file input
          </button>
          ${fileInput({
            id: 'hidden-upload-input',
            testId: 'browser-lab-upload-hidden-input',
            label: 'Hidden file input',
            hidden: true,
            resultId: 'hidden-upload-result',
            resultTestId: 'browser-lab-upload-hidden-result',
          })}
        </section>
        <section aria-labelledby="drop-upload-title">
          <h2 id="drop-upload-title">Drop a file</h2>
          <div
            id="upload-drop-zone"
            tabindex="0"
            role="region"
            aria-label="File drop zone"
            data-testid="browser-lab-upload-drop-zone"
          >
            Drop files here
          </div>
          ${resultOutput(
            'upload-drop-result',
            'browser-lab-upload-drop-result',
          )}
        </section>
        <section aria-labelledby="framed-drop-title">
          <h2 id="framed-drop-title">A drop zone another site fills</h2>
          <div
            role="region"
            aria-label="Framed drop zone"
            data-testid="browser-lab-upload-framed-drop-zone"
            style="width: 320px; height: 160px"
          >
            <iframe
              title="Cross-origin drop frame"
              src="${paired.origin}${DROP_FRAME_PATH}"
              style="width: 100%; height: 100%; border: 0"
            ></iframe>
          </div>
        </section>
        <iframe
          title="Cross-origin upload frame"
          src="${paired.origin}${FRAME_PATH}"
          data-testid="browser-lab-upload-cross-origin-frame"
        ></iframe>
      </main>`,
    });
  };
  const renderDropFrame = () =>
    kit.renderInteractionPage({
      caseDef: interactionCase,
      suffix: 'Cross-origin drop frame',
      header: null,
      scripts: [UPLOAD_SCRIPT],
      main: html`<main>
        <div
          id="upload-drop-zone"
          data-testid="browser-lab-upload-drop-frame-zone"
          style="position: fixed; inset: 0"
        >
          Another site's drop zone
        </div>
        ${resultOutput(
          'upload-drop-result',
          'browser-lab-upload-drop-frame-result',
        )}
      </main>`,
    });
  const renderFrame = () =>
    kit.renderInteractionPage({
      caseDef: interactionCase,
      suffix: 'Cross-origin frame',
      header: null,
      scripts: [UPLOAD_SCRIPT],
      main: html`<main data-testid="browser-lab-upload-frame-main">
        <h1>Choose a file in this frame</h1>
        <form
          method="post"
          action="${ECHO_PATH}"
          enctype="multipart/form-data"
          data-testid="browser-lab-upload-frame-form"
        >
          ${fileInput({
            id: 'frame-upload-input',
            testId: 'browser-lab-upload-frame-input',
            label: 'Choose a file',
            resultId: 'frame-upload-result',
            resultTestId: 'browser-lab-upload-frame-result',
          })}
          <button type="submit" data-testid="browser-lab-upload-frame-submit">
            Upload file
          </button>
        </form>
      </main>`,
    });
  return [
    [
      ENTRY_PATH,
      {
        kind: 'html',
        methods: {
          GET: (context) => {
            const page = renderMain(context);
            if (page) kit.sendPage(context.response, 200, page);
          },
        },
      },
    ],
    [FRAME_PATH, kit.pageRoute(renderFrame)],
    [DROP_FRAME_PATH, kit.pageRoute(renderDropFrame)],
    [ECHO_PATH, uploadEchoRoute(kit, kit.INTERACTION_LIMITS)],
  ];
}
