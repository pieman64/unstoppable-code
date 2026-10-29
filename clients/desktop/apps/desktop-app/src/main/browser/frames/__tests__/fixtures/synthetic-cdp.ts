/**
 * Hand-built CDP responses in Chromium's real shapes (field sets copied from
 * the recordings), only for failure paths a browser cannot produce on
 * demand: per-build caps and malformed data. Structure follows Chromium:
 * `frameId` is on `<html>`, inputs carry user-agent shadow roots, the
 * snapshot is a flat string table with sparse rare fields.
 */
export interface SyntheticPage {
  frameId: string;
  loaderId: string;
  url: string;
  document: unknown;
  snapshot: unknown;
  metrics: unknown;
}

const UA_ROOT_OFFSET = 1_000_000;

/** A page whose body holds `count` inputs that have no layout box. */
export function syntheticInputsPage(count: number): SyntheticPage {
  const frameId = 'SYNTHETICFRAME0000000000000000001';
  const url = 'http://127.0.0.1/synthetic.html';
  const inputs = Array.from({ length: count }, (_, index) => {
    const id = 10 + index;
    return {
      nodeId: id,
      parentId: 4,
      backendNodeId: id,
      nodeType: 1,
      nodeName: 'INPUT',
      localName: 'input',
      nodeValue: '',
      childNodeCount: 0,
      children: [],
      attributes: ['id', `input-${index}`, 'value', `value-${index}`],
      shadowRoots: [
        {
          nodeId: UA_ROOT_OFFSET + id,
          parentId: id,
          backendNodeId: UA_ROOT_OFFSET + id,
          nodeType: 11,
          nodeName: '#document-fragment',
          localName: '',
          nodeValue: '',
          childNodeCount: 0,
          children: [],
          shadowRootType: 'user-agent',
        },
      ],
    };
  });
  const document = {
    root: {
      nodeId: 1,
      backendNodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      localName: '',
      nodeValue: '',
      childNodeCount: 1,
      children: [
        {
          nodeId: 2,
          parentId: 1,
          backendNodeId: 2,
          nodeType: 1,
          nodeName: 'HTML',
          localName: 'html',
          nodeValue: '',
          childNodeCount: 2,
          children: [
            {
              nodeId: 3,
              parentId: 2,
              backendNodeId: 3,
              nodeType: 1,
              nodeName: 'HEAD',
              localName: 'head',
              nodeValue: '',
              childNodeCount: 0,
              children: [],
              attributes: [],
            },
            {
              nodeId: 4,
              parentId: 2,
              backendNodeId: 4,
              nodeType: 1,
              nodeName: 'BODY',
              localName: 'body',
              nodeValue: '',
              childNodeCount: count,
              children: inputs,
              attributes: ['style', 'display: none'],
            },
          ],
          attributes: [],
          frameId,
        },
      ],
      documentURL: url,
      baseURL: url,
      xmlVersion: '',
      compatibilityMode: 'NoQuirksMode',
    },
  };
  const strings = [
    '#document',
    'HTML',
    'HEAD',
    'BODY',
    'INPUT',
    'id',
    'value',
    url,
    frameId,
    'Synthetic',
    'block',
    'visible',
    'style',
    'display: none',
  ];
  const string = (value: string): number => {
    const known = strings.indexOf(value);
    if (known >= 0) return known;
    strings.push(value);
    return strings.length - 1;
  };
  const backendNodeId = [1, 2, 3, 4];
  const parentIndex = [-1, 0, 1, 1];
  const nodeType = [9, 1, 1, 1];
  const nodeName = [0, 1, 2, 3];
  const nodeValue = [-1, -1, -1, -1];
  const attributes: number[][] = [
    [],
    [],
    [],
    [string('style'), string('display: none')],
  ];
  const inputValue: { index: number[]; value: number[] } = {
    index: [],
    value: [],
  };
  for (let index = 0; index < count; index += 1) {
    backendNodeId.push(10 + index);
    parentIndex.push(3);
    nodeType.push(1);
    nodeName.push(4);
    nodeValue.push(-1);
    attributes.push([
      string('id'),
      string(`input-${index}`),
      string('value'),
      string(`value-${index}`),
    ]);
    inputValue.index.push(4 + index);
    inputValue.value.push(string(`live-${index}`));
  }
  const empty = { index: [], value: [] };
  const snapshot = {
    documents: [
      {
        documentURL: string(url),
        title: string('Synthetic'),
        baseURL: string(url),
        contentLanguage: -1,
        encodingName: -1,
        publicId: -1,
        systemId: -1,
        frameId: string(frameId),
        nodes: {
          parentIndex,
          nodeType,
          shadowRootType: empty,
          nodeName,
          nodeValue,
          backendNodeId,
          attributes,
          textValue: empty,
          inputValue,
          inputChecked: { index: [] },
          optionSelected: { index: [] },
          contentDocumentIndex: empty,
          pseudoType: empty,
          pseudoIdentifier: empty,
          isClickable: { index: [] },
          currentSourceURL: empty,
          originURL: empty,
        },
        layout: {
          nodeIndex: [0, 1],
          styles: [
            [string('block'), string('visible')],
            [string('block'), string('visible')],
          ],
          bounds: [
            [0, 0, 800, 600],
            [0, 0, 800, 16],
          ],
          text: [-1, -1],
          stackingContexts: { index: [0] },
          paintOrders: [0, 1],
          offsetRects: [[], []],
          scrollRects: [[], []],
          clientRects: [
            [0, 0, 800, 600],
            [0, 0, 800, 16],
          ],
        },
        textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
        scrollOffsetX: 0,
        scrollOffsetY: 0,
        contentWidth: 800,
        contentHeight: 600,
      },
    ],
    strings,
  };
  const metrics = {
    cssLayoutViewport: {
      pageX: 0,
      pageY: 0,
      clientWidth: 800,
      clientHeight: 600,
    },
  };
  return {
    frameId,
    loaderId: 'SYNTHETICLOADER00000000000000001',
    url,
    document,
    snapshot,
    metrics,
  };
}
