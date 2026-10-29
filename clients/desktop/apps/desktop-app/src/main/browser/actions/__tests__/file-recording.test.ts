import type { BrowserRecordingStep } from '@canopy/desktop-shared/types/browser';
import {
  downloadRecording,
  printRecording,
  recordingScriptBody,
  uploadRecording,
} from '../file-recording';

function step(playwright: string): BrowserRecordingStep {
  return { id: playwright, action: 'click', playwright, timestamp: 1 };
}

describe('file recording steps', () => {
  it('replays an upload by file name only, never a path', () => {
    const upload = uploadRecording({
      names: ['report.csv', 'photo "1".png'],
      locator: "page.getByLabel('Attachment')",
      via: 'input',
    });
    expect(upload).toMatchObject({
      action: 'upload',
      locator: "page.getByLabel('Attachment')",
      values: ['report.csv', 'photo "1".png'],
    });
    expect(upload.playwright).toBe(
      [
        '// Files by name only: put them beside the script, or use their paths.',
        `await page.getByLabel('Attachment').setInputFiles(["report.csv","photo \\"1\\".png"]);`,
      ].join('\n'),
    );
  });

  it('says so when an upload has nothing to replay it on, and when files were dropped', () => {
    expect(uploadRecording({ names: ['a.pdf'], via: 'input' }).playwright).toBe(
      '// The file input has no replayable locator. Files: ["a.pdf"].',
    );
    expect(
      uploadRecording({
        names: ['a.pdf'],
        locator: "page.locator('#zone')",
        via: 'drop',
      }).playwright,
    ).toBe(
      `// Files ["a.pdf"] were dropped on page.locator('#zone'); Playwright cannot replay a file drop.`,
    );
  });

  it('answers a chooser the step before opened, and waits for a download the step before started', () => {
    const steps = [
      step("await page.getByRole('button', { name: 'Attach' }).click();"),
      uploadRecording({ names: ['a.pdf'], via: 'chooser' }),
      step("await page.getByRole('link', { name: 'Export' }).click();"),
      downloadRecording('export.csv'),
      downloadRecording('second.csv'),
    ];
    expect(recordingScriptBody(steps)).toBe(
      [
        "const fileChooser1Promise = page.waitForEvent('filechooser');",
        "await page.getByRole('button', { name: 'Attach' }).click();",
        'const fileChooser1 = await fileChooser1Promise;',
        '// Files by name only: put them beside the script, or use their paths.',
        'await fileChooser1.setFiles(["a.pdf"]);',
        "const download2Promise = page.waitForEvent('download');",
        // Each later download waits until the one before it has arrived.
        "const download3Promise = download2Promise.then(() => page.waitForEvent('download'));",
        "await page.getByRole('link', { name: 'Export' }).click();",
        'const download2 = await download2Promise; // "export.csv"',
        'const download3 = await download3Promise; // "second.csv"',
      ].join('\n'),
    );
  });

  it('waits for a chooser from the step that opened it, and for a download its attach started from the attach', () => {
    const at = (
      playwright: string,
      timestamp: number,
    ): BrowserRecordingStep => ({
      ...step(playwright),
      timestamp,
    });
    const upload = {
      ...uploadRecording({ names: ['a.pdf'], via: 'chooser' }),
      timestamp: 5,
      chooserOpenedAt: 2,
    };
    const download = { ...downloadRecording('receipt.pdf'), timestamp: 6 };
    expect(
      recordingScriptBody([
        at(
          "await page.getByRole('button', { name: 'Choose file' }).click();",
          1,
        ),
        at("await page.getByLabel('Name').fill('Ada');", 3),
        upload,
        download,
      ]),
    ).toBe(
      [
        "const fileChooser1Promise = page.waitForEvent('filechooser');",
        "await page.getByRole('button', { name: 'Choose file' }).click();",
        "await page.getByLabel('Name').fill('Ada');",
        "const download2Promise = page.waitForEvent('download');",
        'const fileChooser1 = await fileChooser1Promise;',
        '// Files by name only: put them beside the script, or use their paths.',
        'await fileChooser1.setFiles(["a.pdf"]);',
        'const download2 = await download2Promise; // "receipt.pdf"',
      ].join('\n'),
    );
  });

  it('writes a chooser upload as a comment when no recorded step opened its chooser', () => {
    const upload = {
      ...uploadRecording({ names: ['a.pdf'], via: 'chooser' }),
      timestamp: 5,
      chooserOpenedAt: 2,
    };
    expect(
      recordingScriptBody([
        { ...step("await page.getByLabel('Name').fill('Ada');"), timestamp: 3 },
        upload,
      ]),
    ).toBe(
      [
        "await page.getByLabel('Name').fill('Ada');",
        '// A file chooser was answered here with no recorded step before it: ["a.pdf"].',
      ].join('\n'),
    );
  });

  it('writes a wait with no step before it as a comment, so the script neither hangs nor declares a name twice', () => {
    const download = downloadRecording('export.csv');
    expect(download).toMatchObject({ action: 'download', value: 'export.csv' });
    expect(
      recordingScriptBody([
        download,
        downloadRecording('second.csv'),
        uploadRecording({ names: ['a.pdf'], via: 'chooser' }),
      ]),
    ).toBe(
      [
        '// A download started here with no recorded step before it: "export.csv".',
        '// A download started here with no recorded step before it: "second.csv".',
        '// A file chooser was answered here with no recorded step before it: ["a.pdf"].',
      ].join('\n'),
    );
  });

  it('keeps a page-chosen name from ending the comment or string it is in', () => {
    const name = 'report\u2028await fetch("https://evil.example")\u2029.csv';
    for (const recorded of [
      downloadRecording(name),
      uploadRecording({
        names: [name],
        locator: "page.locator('#f')",
        via: 'input',
      }),
    ]) {
      expect(recorded.playwright).not.toMatch(/[\u2028\u2029]/);
      expect(recorded.playwright).toContain('\\u2028');
    }
    expect(
      recordingScriptBody([
        step('await page.click();'),
        downloadRecording(name),
      ]),
    ).not.toMatch(/[\u2028\u2029]/);
  });

  it('prints with the options save_pdf used, as page.pdf()', () => {
    expect(
      printRecording({
        landscape: true,
        printBackground: true,
        scale: 1,
        format: 'A4',
        pageRanges: '1-2',
      }).playwright,
    ).toBe(
      [
        '// page.pdf() runs only in headless Chromium.',
        'await page.pdf({"landscape":true,"printBackground":true,"scale":1,"format":"A4","pageRanges":"1-2"});',
      ].join('\n'),
    );
  });
});
