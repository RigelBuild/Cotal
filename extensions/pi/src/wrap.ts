import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface WrappedText {
  render(width: number): string[];
  invalidate(): void;
}

/**
 * Pi TUI component for static Cotal text.
 *
 * Pi's renderer requires every returned line to fit the `width` column budget.
 * Use the host's own ANSI/grapheme-aware wrapper so Cotal and Pi cannot disagree
 * about the width of emoji, CJK, combining marks, or styled text.
 */
export function wrapped(line: string): WrappedText {
  return {
    invalidate(): void {},
    render(width: number): string[] {
      return wrapTextWithAnsi(line, Math.max(1, width));
    },
  };
}
