export function insertTextAtSelection(args: {
  value: string;
  insertedText: string;
  selectionStart: number;
  selectionEnd: number;
}): {
  value: string;
  cursorPosition: number;
} {
  const nextValue =
    args.value.slice(0, args.selectionStart) +
    args.insertedText +
    args.value.slice(args.selectionEnd);
  const cursorPosition = args.selectionStart + args.insertedText.length;

  return {
    value: nextValue,
    cursorPosition,
  };
}
