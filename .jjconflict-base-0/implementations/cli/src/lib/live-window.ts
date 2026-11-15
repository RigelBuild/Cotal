import { brand, dim, fit, fmtDuration } from "./theme.js";

const WINDOW = 3; // lines of rolling tail under the spinner header
const FRAMES = ["◒", "◐", "◓", "◑"];
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

/**
 * A fixed-height rolling tail under a spinner header, so a slow step shows live
 * progress instead of a frozen spinner. Modeled on nanoclaw's windowed-runner.
 *
 * Purely transient: `start` opens the pane, `push` feeds it lines, `clear` wipes it
 * and restores the cursor. The caller (the step runner) emits the permanent ✓/✗ line,
 * so the pane never competes with clack's log output. On a non-TTY (CI/piped) every
 * method is a no-op and lines are dropped; the runner's plain status line is enough.
 */
export class LivePane {
  private readonly tty = Boolean(process.stdout.isTTY);
  private readonly lines: string[] = [];
  private label = "";
  private start0 = 0;
  private frame = 0;
  private ticker?: ReturnType<typeof setInterval>;

  start(label: string): void {
    if (!this.tty) return;
    this.label = label;
    this.start0 = Date.now();
    const out = process.stdout;
    out.write(HIDE);
    for (let i = 0; i < WINDOW + 1; i++) out.write("\n");
    this.redraw();
    process.once("exit", () => out.write(SHOW));
    this.ticker = setInterval(() => {
      this.frame++;
      this.redraw();
    }, 200);
  }

  push(chunk: string): void {
    if (!this.tty) return;
    for (const raw of chunk.split("\n")) {
      // eslint-disable-next-line no-control-regex
      const clean = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
      if (clean) this.lines.push(clean);
    }
    this.redraw();
  }

  clear(): void {
    if (!this.tty) return;
    if (this.ticker) clearInterval(this.ticker);
    const out = process.stdout;
    out.write(`\x1b[${WINDOW + 1}A`);
    for (let i = 0; i < WINDOW + 1; i++) out.write("\x1b[2K\n");
    out.write(`\x1b[${WINDOW + 1}A${SHOW}`);
  }

  private redraw(): void {
    const out = process.stdout;
    out.write(`\x1b[${WINDOW + 1}A`);
    const suffix = ` (${fmtDuration(Date.now() - this.start0)})`;
    out.write(`\x1b[2K${brand(FRAMES[this.frame % FRAMES.length])}  ${this.label}${dim(suffix)}\n`);
    for (let i = 0; i < WINDOW; i++) {
      const line = this.lines[this.lines.length - WINDOW + i] ?? "";
      out.write(`\x1b[2K${line ? `${dim("│")}  ${dim(fit(line))}` : dim("│")}\n`);
    }
  }
}
