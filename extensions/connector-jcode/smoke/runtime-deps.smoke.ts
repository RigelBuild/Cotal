// Seed installs package.json dependencies before a connector runs, so bundled libraries must stay dev-only.
// Compare the manifest with imports from every published JavaScript entrypoint.
import nodeAssert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, relative } from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PACKAGE_DIR = join(ROOT, "extensions", "connector-jcode");
const DIST_DIR = join(PACKAGE_DIR, "dist");
const rawManifest: unknown = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8"));
if (typeof rawManifest !== "object" || rawManifest === null || Array.isArray(rawManifest)) {
  throw new Error("connector package.json must contain an object");
}
// SAFETY: JSON.parse was checked as a non-null, non-array object above.
const manifest = rawManifest as { [field: string]: unknown };
const readStringMap = (field: string): Record<string, string> => {
  const value = manifest[field];
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`package.json ${field} must be an object`);
  }
  const result: Record<string, string> = {};
  for (const [name, version] of Object.entries(value)) {
    if (typeof version !== "string") throw new Error(`package.json ${field}.${name} must be a string`);
    result[name] = version;
  }
  return result;
};

const dependencies = readStringMap("dependencies");
const optionalDependencies = readStringMap("optionalDependencies");
const peerDependencies = readStringMap("peerDependencies");

const runtimeResolvable = new Set([
  ...Object.keys(dependencies),
  ...Object.keys(optionalDependencies),
  ...Object.keys(peerDependencies),
]);

const distFiles = ["index.js", "host.js", "mcp.js"];
const importedPackages = new Set<string>();
const packageName = (specifier: string): string =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/", 1)[0];

const runtimeSpecifiers = (source: string): string[] => {
  const file = ts.createSourceFile("dist.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const [argument] = node.arguments;
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      // esbuild's ESM output rewrites CJS requires of externals to `__require("pkg")`.
      const commonJsRequire = ts.isIdentifier(node.expression) &&
        (node.expression.text === "require" || node.expression.text === "__require");
      if ((dynamicImport || commonJsRequire) && argument && ts.isStringLiteral(argument)) {
        out.push(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
};

for (const file of distFiles) {
  const path = join(DIST_DIR, file);
  assert.ok(existsSync(path), `published dist entry exists: ${relative(ROOT, path)}`);
  const source = readFileSync(path, "utf8");
  for (const specifier of runtimeSpecifiers(source)) {
    if (!isBuiltin(specifier) && !specifier.startsWith(".") && !specifier.startsWith("#")) {
      importedPackages.add(packageName(specifier));
    }
  }
}

const runtimeDependencies = [...Object.keys(dependencies), ...Object.keys(optionalDependencies)].sort();
const unusedRuntimeDependencies = runtimeDependencies.filter((dependency) => !importedPackages.has(dependency));
assert.equal(
  unusedRuntimeDependencies.length,
  0,
  `published runtime dependencies are imported by connector dist: ${unusedRuntimeDependencies.join(", ")}`,
);
for (const dependency of [...importedPackages].sort()) {
  const resolvable = runtimeResolvable.has(dependency);
  assert.equal(resolvable, true, `external connector dist import is runtime-resolvable: ${dependency}`);
}

console.log(`jcode-runtime-deps: ${[...importedPackages].sort().join(", ") || "no external packages"}`);
emitSentinel({ passed: cells(), failed: 0 });
