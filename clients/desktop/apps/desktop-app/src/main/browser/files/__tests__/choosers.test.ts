import { chooserDialogOptions } from '../choosers';

describe('chooserDialogOptions', () => {
  it('opens one file, several, or a folder, as the input asks', () => {
    expect(chooserDialogOptions({ multiple: false })).toEqual({
      properties: ['openFile'],
    });
    expect(chooserDialogOptions({ multiple: true })).toEqual({
      properties: ['openFile', 'multiSelections'],
    });
    expect(chooserDialogOptions({ multiple: false, directory: true })).toEqual({
      properties: ['openDirectory'],
    });
  });

  it('filters by the extensions in accept, and by nothing when accept names a type', () => {
    expect(
      chooserDialogOptions({ multiple: false, accept: '.CSV, .txt,.csv' }),
    ).toEqual({
      properties: ['openFile'],
      filters: [{ name: 'Files', extensions: ['csv', 'txt'] }],
    });
    expect(
      chooserDialogOptions({ multiple: false, accept: 'image/*,.png' }),
    ).toEqual({ properties: ['openFile'] });
    expect(chooserDialogOptions({ multiple: false, accept: ' , ' })).toEqual({
      properties: ['openFile'],
    });
  });

  it('carries a title when one is given', () => {
    expect(
      chooserDialogOptions({
        multiple: false,
        title: 'Choose a file for upload.example',
      }),
    ).toEqual({
      title: 'Choose a file for upload.example',
      properties: ['openFile'],
    });
  });
});
