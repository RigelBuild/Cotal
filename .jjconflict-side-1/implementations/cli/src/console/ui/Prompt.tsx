import { Box, Text, useInput } from "ink";

/** A one-line labeled input shown in the bottom region (lazygit-style: a key opens it, you type a
 *  value, Enter submits, Esc cancels). Owns input while mounted. The label carries the target,
 *  e.g. `→ #general` / `→ @alice` / `↩ bob`. */
export function Prompt({
  label,
  value,
  width,
  onChange,
  onSubmit,
  onCancel,
}: {
  label: string;
  value: string;
  width: number;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.return) return onSubmit();
    if (key.backspace || key.delete) return onChange(value.slice(0, -1));
    if (input && !key.ctrl && !key.meta) onChange(value + input);
  });
  return (
    <Box width={width} paddingX={1}>
      <Text wrap="truncate-end">
        <Text color="cyan">{label + " "}</Text>
        <Text>{value}</Text>
        <Text inverse> </Text>
        <Text dimColor>{"   Enter sends · Esc cancels"}</Text>
      </Text>
    </Box>
  );
}
