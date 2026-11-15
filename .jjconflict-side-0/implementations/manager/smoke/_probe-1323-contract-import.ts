/** Count actual Ajv compilation work in a fresh process while importing the manager contract module.
 * Run by contract-vocabulary.smoke.ts. The wrapper is installed on the Ajv 2020-12 constructor
 * resolved from the core package itself, so it observes the same class the module under test uses.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

interface AjvInstance { compile(...args: unknown[]): unknown }
interface AjvConstructor {
  new(options: { strict: false }): AjvInstance;
  prototype: AjvInstance;
}

function isAjvConstructor(value: unknown): value is AjvConstructor {
  if (typeof value !== "function" || !("prototype" in value)) return false;
  const prototype: unknown = value.prototype;
  return typeof prototype === "object" && prototype !== null
    && "compile" in prototype && typeof prototype.compile === "function";
}

function isAjvModule(value: unknown): value is { Ajv2020: AjvConstructor } {
  return typeof value === "object" && value !== null && "Ajv2020" in value
    && isAjvConstructor(value.Ajv2020);
}

// Resolve through core's package boundary so the counter wraps the exact Ajv module instance used
// by schema-profile; the manager package cannot statically resolve core's private dependency.
const coreRequire = createRequire(new URL("../../../packages/core/package.json", import.meta.url));
const ajvUrl = pathToFileURL(coreRequire.resolve("ajv/dist/2020.js")).href;
const ajvModule: unknown = await import(ajvUrl);
if (!isAjvModule(ajvModule)) throw new Error("the core package did not resolve Ajv2020");
const Ajv2020 = ajvModule.Ajv2020;
const originalCompile = Ajv2020.prototype.compile;
let compileCalls = 0;
Ajv2020.prototype.compile = function (this: AjvInstance, ...args: unknown[]): unknown {
  compileCalls++;
  return Reflect.apply(originalCompile, this, args);
};

const probe = new Ajv2020({ strict: false });
compileCalls = 0;
probe.compile({ type: "string" });
if (compileCalls !== 1) throw new Error(`Ajv.compile instrumentation observed ${compileCalls} calls for one schema`);

const core = await import("@cotal-ai/core");
compileCalls = 0;
// Import the dependency floor first, then count only work caused by importing the manager contract module.
const manager = await import("../src/manager-service-contract.js");
void manager.managerClusterDocument().commands[0]?.inputDigest;

const importCalls = compileCalls;
// Compile through the public core entry to prove the counter observes core's Ajv instance.
compileCalls = 0;
core.compileContract({ root: { type: "string" } });
const controlCalls = compileCalls;
if (controlCalls === 0) throw new Error("Ajv.compile instrumentation missed the core positive control");
console.log(`PROBE ${importCalls} ${controlCalls}`);
