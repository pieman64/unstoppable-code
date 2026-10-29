// Keep native sender/frame identities in main; serializing them loses the
// object equality required by the trusted desktop IPC caller gate.
export async function evaluateWithSyntheticIpcEvent(
  electronApp,
  callback,
  args,
) {
  const event = await electronApp.evaluateHandle(({ BrowserWindow }) => {
    const sender = BrowserWindow.getAllWindows()[0].webContents;
    return { sender, senderFrame: sender.mainFrame };
  });
  try {
    return await electronApp.evaluate(callback, { event, args });
  } finally {
    await event.dispose();
  }
}
