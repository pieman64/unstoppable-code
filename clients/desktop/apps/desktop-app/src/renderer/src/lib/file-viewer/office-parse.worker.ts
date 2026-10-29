// Vite bundles this entry (and its Mammoth/SheetJS/pako graph) into its own
// worker asset. Nothing here may import React, the DOM, or window.api.
import {
  installOfficeParseWorker,
  type OfficeWorkerScope,
} from '@canopy/ui-rich/office/worker';

declare const self: OfficeWorkerScope;

installOfficeParseWorker(self);
