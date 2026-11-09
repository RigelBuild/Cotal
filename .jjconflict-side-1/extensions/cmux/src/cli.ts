/**
 * Tiny entrypoint so launchers can drive cmux without hardcoding its CLI:
 *   tsx cli.ts check                 exit 0 if cmux is reachable, else 1
 *   tsx cli.ts open <name> <layout>  open a workspace with the given layout JSON
 */
import * as cmux from "./driver.js";

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "check":
    process.exit(cmux.available() ? 0 : 1);
  case "open": {
    const [name, layout] = rest;
    if (!name || !layout) {
      console.error("usage: cli.ts open <name> <layoutJson>");
      process.exit(2);
    }
    if (!cmux.available()) {
      console.error("✗ can't reach cmux — run this from inside a cmux terminal.");
      process.exit(1);
    }
    cmux.openWorkspace(name, layout);
    break;
  }
  default:
    console.error("usage: cli.ts <check | open <name> <layoutJson>>");
    process.exit(2);
}
