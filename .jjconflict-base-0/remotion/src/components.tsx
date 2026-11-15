import React from "react";
import { C, GRID_STYLE, groupSpans, tickerCells, type Dot } from "./_shared";

// One grid row with any dots overlaid at their columns.
function Row({ row, dots }: { row: string; dots: Dot[] }) {
  if (dots.length === 0) return <div style={{ margin: 0, padding: 0 }}>{row}</div>;
  const sorted = [...dots].sort((a, b) => a.col - b.col);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < sorted.length; i++) {
    const d = sorted[i]!;
    if (d.col > cursor) parts.push(row.slice(cursor, d.col));
    parts.push(
      <span key={i} style={{ color: d.color }}>
        {d.char ?? "•"}
      </span>,
    );
    cursor = d.col + 1;
  }
  if (cursor < row.length) parts.push(row.slice(cursor));
  return <div style={{ margin: 0, padding: 0 }}>{parts}</div>;
}

// Render a full monospace grid, overlaying colored dots by row/col.
export function Grid({
  grid,
  dots = [],
  top = 16,
  fontSize = 16,
}: {
  grid: string[];
  dots?: Dot[];
  top?: number;
  fontSize?: number;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top,
        transform: "translateX(-50%)",
        ...GRID_STYLE,
        fontSize,
        lineHeight: `${fontSize}px`,
      }}
    >
      {grid.map((row, y) => (
        <Row key={y} row={row} dots={dots.filter((d) => d.row === y)} />
      ))}
    </div>
  );
}

// Pulsing phase label (the live subject) just above the ticker.
export function PhaseLabel({ label, color, t }: { label: string; color: string; t: number }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 52,
        textAlign: "center",
        ...GRID_STYLE,
        fontSize: 13,
        color,
        opacity: 0.55 + 0.45 * Math.sin(t * Math.PI),
      }}
    >
      {label}
    </div>
  );
}

// Scrolling event-log ticker (one row, clipped).
export function Ticker({ frame, cols = 152 }: { frame: number; cols?: number }) {
  const spans = groupSpans(tickerCells(frame, cols));
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 26,
        ...GRID_STYLE,
        fontSize: 14,
        lineHeight: "14px",
        overflow: "hidden",
        padding: "0 14px",
      }}
    >
      {spans.map((s, i) => (
        <span key={i} style={{ color: s.color }}>
          {s.text}
        </span>
      ))}
    </div>
  );
}

// Bottom tagline + blinking cursor.
export function Tagline({ text, frame }: { text: string; frame: number }) {
  const on = frame % 30 < 15;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 6,
        textAlign: "center",
        ...GRID_STYLE,
        fontSize: 12,
        color: C.text,
      }}
    >
      {text}
      <span style={{ color: C.white, opacity: on ? 1 : 0, marginLeft: 4 }}>▌</span>
    </div>
  );
}
