/* eslint-disable @typescript-eslint/explicit-function-return-type -- Minimal Electron window doubles. */
const windows: Array<{
  isDestroyed: () => boolean;
  webContents: { isDestroyed: () => boolean; setZoomFactor: jest.Mock };
}> = [];
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => windows },
  screen: {},
}));
jest.mock('../../browser/visual-preview-service', () => ({
  isVisualPreviewWindow: (window: unknown) => window === windows[0],
}));
import { applyUiZoomToAllWindows } from '../ui-zoom';

it('does not change the preview window zoom', () => {
  const preview = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, setZoomFactor: jest.fn() },
  };
  const regular = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, setZoomFactor: jest.fn() },
  };
  windows.splice(0, windows.length, preview, regular);
  applyUiZoomToAllWindows(1.25);
  expect(preview.webContents.setZoomFactor).not.toHaveBeenCalled();
  expect(regular.webContents.setZoomFactor).toHaveBeenCalledWith(1.25);
});
