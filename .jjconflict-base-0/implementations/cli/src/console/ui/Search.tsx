import { Box, Text, useInput } from "ink";

/** A one-line search/filter input shown above the status bar. While `active` it owns input
 *  (type to filter live, Backspace edits, Enter applies + closes, Esc clears + closes). When a
 *  query persists but the input is closed it shows as an active filter the global Esc can clear. */
export function Search({
  query,
  active,
  width,
  onChange,
  onSubmit,
  onCancel,
}: {
  query: string;
  active: boolean;
  width: number;
  onChange: (q: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  useInput(
    (input, key) => {
      if (key.escape) return onCancel();
      if (key.return) return onSubmit();
      if (key.backspace || key.delete) return onChange(query.slice(0, -1));
      if (input && !key.ctrl && !key.meta) onChange(query + input);
    },
    { isActive: active },
  );
  return (
    <Box width={width} paddingX={1}>
      <Text wrap="truncate-end">
        <Text color="yellow">/ </Text>
        <Text>{query}</Text>
        {active ? <Text inverse> </Text> : <Text dimColor>{"  (Esc clears · / edits)"}</Text>}
      </Text>
    </Box>
  );
}
