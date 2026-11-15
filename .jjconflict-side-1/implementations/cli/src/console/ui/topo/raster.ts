// Character-grid rasterizer shared by the sequence and map variants. A row is an
// array of styled cells; stamping later overwrites earlier (draw order = precedence).
// Rows render as ONE <Text> of run-length-merged segments — never per-cell elements,
// which would melt Ink at full-screen sizes.

export interface Cell {
  ch: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
  inverse?: boolean;
}

export type CellStyle = Omit<Cell, "ch">;

export function blankRow(width: number): Cell[] {
  return Array.from({ length: width }, () => ({ ch: " " }));
}

export function blankGrid(width: number, height: number): Cell[][] {
  return Array.from({ length: height }, () => blankRow(width));
}

/** Stamp text into a row at x; clips at both edges. */
export function stamp(row: Cell[], x: number, text: string, style: CellStyle = {}): void {
  for (let i = 0; i < text.length; i++) {
    const px = x + i;
    if (px < 0 || px >= row.length) continue;
    row[px] = { ch: text[i], ...style };
  }
}

export interface Segment extends CellStyle {
  text: string;
}

/** Run-length merge a row of cells into renderable segments. */
export function toSegments(row: Cell[]): Segment[] {
  const out: Segment[] = [];
  for (const c of row) {
    const last = out[out.length - 1];
    if (
      last &&
      last.color === c.color &&
      !last.dim === !c.dim &&
      !last.bold === !c.bold &&
      !last.inverse === !c.inverse
    )
      last.text += c.ch;
    else out.push({ text: c.ch, color: c.color, dim: c.dim, bold: c.bold, inverse: c.inverse });
  }
  return out;
}
