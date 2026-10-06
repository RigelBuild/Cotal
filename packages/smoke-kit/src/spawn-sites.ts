/**
 * Enumerate every site in this repo that starts a `nats-server`, and decide for each whether it is
 * ADOPTED: minted through {@link SMOKE_BROKER_TOKEN} and handed to {@link teardownOnSignal}.
 *
 * WHY THIS IS AN ENUMERATION AND NOT A LIST OF FILENAMES. #1008 was filed against five named suites,
 * and those five were migrated. That fixed the five and protected nothing: the reaper's own header
 * says it "is only ever as complete as the migration that mints the token", so the standing defect is
 * that nothing notices the SIXTH suite. A gate naming files re-acquires the same blind spot the
 * moment somebody adds one. This walks `git ls-files` instead, so a new spawn site is in the
 * population the commit it lands in, with no list to remember to update.
 *
 * WHAT ADOPTION MEANS, and why both halves are required rather than either one:
 *
 *   TOKEN. The reaper matches on argv and nothing else, for the measured reasons in its header. So
 *   the token has to be in a path the broker is STARTED with, not merely somewhere in the suite. A
 *   `-sd` store dir and a `-c` config path are both argv paths and both count; a broker started with
 *   neither carries no evidence at all and can never be claimed, which is why `no-store` is a failure
 *   rather than a category to skip.
 *
 *   OWNERSHIP. The token only helps after the owner is dead. `teardownOnSignal` is what kills the
 *   broker when the suite is signalled, which is the common case. Ownership is checked against the
 *   binding the spawn result is assigned to, not against the file, because a file that owns ONE of
 *   its two brokers would otherwise read as clean.
 *
 * WHAT IS DELIBERATELY OUT OF SCOPE, each with a reason rather than a convenience:
 *
 *   SHIPPED CODE. `@cotal-ai/smoke-kit` is test-only and `pnpm smoke:core-boundary` forbids shipped
 *   files from importing it. A shipped file that starts a broker cannot adopt the helper without
 *   breaking that boundary, so it is reported separately instead of being counted as a violation the
 *   repo is not allowed to fix.
 *
 *   NEGATIVE CONTROLS. A reaper test must be able to spawn a deliberately untokened broker, since
 *   that is the condition it exists to detect. Those sites opt out with an explicit
 *   `SMOKE_BROKER_UNADOPTED_OK` marker comment, which makes the exemption greppable and per-site
 *   rather than a silent exclusion.
 *
 * A VERSION MATCHING ARGV RATHER THAN SOURCE WAS TRIED AND REJECTED. Reading `ps` tells you what is
 * running now, which depends on which suites happened to run; this has to be true of the repo, not of
 * the box, so it reads source.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

/** One place in the source that starts a `nats-server`. */
export interface SpawnSite {
  readonly file: string;
  readonly line: number;
  /** `store` = `-sd <dir>`, `config` = `-c <file>`, `none` = neither, so argv carries no evidence. */
  readonly argvPath: "store" | "config" | "none";
  /** The source text of the argv path, for a diagnosis that names what to change. */
  readonly pathExpr?: string;
  readonly tokened: boolean;
  readonly owned: boolean;
  /** Shipped (non-test) code, which may not import the test-only kit. */
  readonly shipped: boolean;
  /** Carries the explicit opt-out marker. */
  readonly exempt: boolean;
}

/** Sites a migration is responsible for: test code, not exempted. */
export const isAdopted = (s: SpawnSite): boolean => s.tokened && s.owned;
export const inScope = (s: SpawnSite): boolean => !s.shipped && !s.exempt;

/** The marker a negative control uses to opt out, on or above the spawn line. */
export const EXEMPT_MARKER = "SMOKE_BROKER_UNADOPTED_OK";

const TEST_RE = /(^|\/)(smoke|test|tests|fixtures)\//;
const TEST_FILE_RE = /\.(smoke|acceptance|test|spec)\.[cm]?[jt]s$/;

/** Split an argument list at top-level commas, respecting nesting and every quote form. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "", quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote !== null) {
      if (c === "\\") { cur += c + (s[++i] ?? ""); continue; }
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; cur += c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/** The balanced text inside a call whose `(` is at `open`. */
function callBody(src: string, open: number): string | null {
  let depth = 0, quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (quote !== null) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return null;
}

/** Preserve code offsets while masking TypeScript literals, regexes, and comments. */
function codeOnly(src: string): string {
  const chars = src.split("");
  const file = ts.createSourceFile("source.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const mask = (start: number, end: number): void => {
    for (let i = start; i < end; i++) if (chars[i] !== "\n") chars[i] = " ";
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      mask(node.getStart(file), node.end);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      mask(node.getStart(file), node.head.end);
      for (const span of node.templateSpans) {
        visit(span.expression);
        mask(span.literal.getStart(file), span.literal.end);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, chars.join(""));
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
    const kind = scanner.getToken();
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      mask(scanner.getTokenPos(), scanner.getTextPos());
    }
  }
  return chars.join("");
}

/** Remove comments while preserving literals and source offsets. */
function withoutComments(src: string, file: ts.SourceFile): string {
  const chars = src.split("");
  const mask = (start: number, end: number): void => {
    for (let i = start; i < end; i++) if (chars[i] !== "\n") chars[i] = " ";
  };
  const visit = (node: ts.Node): void => {
    const ranges = [
      ...(ts.getLeadingCommentRanges(src, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(src, node.getFullStart()) ?? []),
      ...(ts.getLeadingCommentRanges(src, node.end) ?? []),
      ...(ts.getTrailingCommentRanges(src, node.end) ?? []),
    ];
    for (const range of ranges) mask(range.pos, range.end);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || node.kind === ts.SyntaxKind.RegularExpressionLiteral) return;
    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return chars.join("");
}

function isLexicalScope(node: ts.Node): boolean {
  return ts.isSourceFile(node) || ts.isBlock(node) || ts.isFunctionLike(node) || ts.isCatchClause(node)
    || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node);
}

/** Keep binding and initializer locations separate for lexical resolution. */
type Binding = {
  readonly value: string;
  readonly scopes: readonly ts.Node[];
  readonly offset: number;
  readonly valueScopes: readonly ts.Node[];
  readonly valueOffset: number;
  readonly token: boolean;
};

/** Collect local initializers without merging declarations from sibling scopes. */
function bindings(src: string): { file: ts.SourceFile; defs: Map<string, Binding[]> } {
  const file = ts.createSourceFile("source.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const defs = new Map<string, Binding[]>();
  const add = (
    name: string,
    value: string,
    scopes: readonly ts.Node[],
    offset: number,
    valueScopes: readonly ts.Node[] = scopes,
    valueOffset: number = offset,
    token = false,
  ): void => {
    const list = defs.get(name) ?? [];
    list.push({ value, scopes, offset, valueScopes, valueOffset, token });
    defs.set(name, list);
  };
  const visit = (node: ts.Node, parentScopes: readonly ts.Node[]): void => {
    const scopes = isLexicalScope(node) ? [...parentScopes, node] : parentScopes;
    if (ts.isVariableDeclaration(node)) {
      const value = node.initializer === undefined ? "" : src.slice(node.initializer.getStart(file), node.initializer.end);
      const declarationScopes = node.parent.flags & ts.NodeFlags.BlockScoped
        ? scopes
        : scopes.filter((scope) => ts.isSourceFile(scope) || ts.isFunctionLike(scope));
      const valueOffset = node.initializer?.getStart(file) ?? node.getStart(file);
      if (ts.isIdentifier(node.name)) add(node.name.text, value, declarationScopes, node.getStart(file), scopes, valueOffset);
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const property = element.propertyName ?? element.name;
          if (!ts.isIdentifier(element.name) || !(ts.isIdentifier(property) || ts.isStringLiteral(property))) continue;
          const moduleCall = node.initializer !== undefined && ts.isAwaitExpression(node.initializer)
            ? node.initializer.expression
            : node.initializer;
          const source = moduleCall !== undefined && ts.isCallExpression(moduleCall)
            && moduleCall.expression.kind === ts.SyntaxKind.ImportKeyword
            && moduleCall.arguments.length === 1 && ts.isStringLiteral(moduleCall.arguments[0]!)
            ? moduleCall.arguments[0]!.text
            : "";
          const kitToken = source === "@cotal-ai/smoke-kit" && property.text === "SMOKE_BROKER_TOKEN";
          add(element.name.text, kitToken ? "" : value === "" ? "" : `(${value}).${property.text}`,
            declarationScopes, node.getStart(file), scopes, valueOffset, kitToken);
        }
      }
    }
    if (ts.isImportSpecifier(node)) {
      const declaration = node.parent.parent.parent;
      const imported = node.propertyName?.text ?? node.name.text;
      if (ts.isImportDeclaration(declaration)
        && ts.isStringLiteral(declaration.moduleSpecifier)
        && declaration.moduleSpecifier.text === "@cotal-ai/smoke-kit"
        && imported === "SMOKE_BROKER_TOKEN") {
        add(node.name.text, "", [file], node.getStart(file), [file], node.getStart(file), true);
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      const declarationScopes = scopes.filter((scope) => ts.isSourceFile(scope) || ts.isFunctionLike(scope));
      add(node.name.text, "", declarationScopes, node.getStart(file));
    }

    ts.forEachChild(node, (child) => visit(child, scopes));
  };
  const collectAssignments = (node: ts.Node, parentScopes: readonly ts.Node[]): void => {
    const scopes = isLexicalScope(node) ? [...parentScopes, node] : parentScopes;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      const visible = (defs.get(node.left.text) ?? []).filter((binding) =>
        binding.scopes.length <= scopes.length
        && binding.scopes.every((scope, index) => scopes[index] === scope)
        && (binding.scopes.length < scopes.length || binding.offset < node.getStart(file)),
      );
      const depth = Math.max(0, ...visible.map((binding) => binding.scopes.length));
      const nearest = visible.filter((binding) => binding.scopes.length === depth);
      const prior = nearest.length === 0 ? undefined : nearest.reduce((left, right) => left.offset > right.offset ? left : right);
      const targetScopes = prior?.scopes ?? scopes;
      const assigned = src.slice(node.right.getStart(file), node.right.end);
      const selfReference = identifiers(assigned).includes(node.left.text) && prior !== undefined;
      const value = selfReference ? `${prior.value} ${assigned}` : assigned;
      const valueScopes = selfReference ? prior.valueScopes : scopes;
      const valueOffset = selfReference ? prior.valueOffset : node.right.getStart(file);
      add(node.left.text, value, targetScopes, node.getStart(file), valueScopes, valueOffset);
    }
    ts.forEachChild(node, (child) => collectAssignments(child, scopes));
  };
  visit(file, []);
  collectAssignments(file, []);
  return { file, defs };
}

function scopesAt(file: ts.SourceFile, offset: number): ts.Node[] {
  let result: ts.Node[] = [];
  const visit = (node: ts.Node, parentScopes: readonly ts.Node[]): void => {
    if (offset < node.getFullStart() || offset > node.end) return;
    const scopes = isLexicalScope(node) ? [...parentScopes, node] : parentScopes;
    result = [...scopes];
    ts.forEachChild(node, (child) => visit(child, scopes));
  };
  visit(file, []);
  return result;
}

function visibleBindings(name: string, defs: Map<string, Binding[]>, scopes: readonly ts.Node[], offset: number): Binding[] {
  const deferred = scopes.findIndex((scope) => ts.isFunctionLike(scope));
  const visible = (defs.get(name) ?? []).filter((binding) =>
    binding.scopes.length <= scopes.length
      && binding.scopes.every((scope, index) => scopes[index] === scope)
      && (binding.offset <= offset || deferred >= 0 && binding.scopes.length <= deferred),
  );
  const nearestScope = Math.max(0, ...visible.map((binding) => binding.scopes.length));
  const nearest = visible.filter((binding) => binding.scopes.length === nearestScope);
  return nearest.length === 0 ? [] : [nearest.reduce((left, right) => left.offset > right.offset ? left : right)];
}
function teardownCalls(file: ts.SourceFile, defs: Map<string, Binding[]>): ts.CallExpression[] {
  const imports = new Map<string, ts.Node>();
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && (node.propertyName?.text ?? node.name.text) === "teardownOnSignal") {
      const declaration = node.parent.parent.parent;
      if (ts.isImportDeclaration(declaration) && ts.isStringLiteral(declaration.moduleSpecifier)
        && declaration.moduleSpecifier.text === "@cotal-ai/smoke-kit") imports.set(node.name.text, node);
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer !== undefined) {
      const expression = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (ts.isCallExpression(expression) && expression.expression.kind === ts.SyntaxKind.ImportKeyword
        && expression.arguments.length === 1 && ts.isStringLiteral(expression.arguments[0]!)
        && expression.arguments[0]!.text === "@cotal-ai/smoke-kit") {
        for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name) && (element.propertyName?.getText(file) ?? element.name.text) === "teardownOnSignal")
            imports.set(element.name.text, node);
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls.filter((call) => {
    const callee = call.expression;
    if (!ts.isIdentifier(callee)) return false;
    const imported = imports.get(callee.text);
    if (imported === undefined) return false;
    return visibleBindings(callee.text, defs, scopesAt(file, callee.getStart(file)), callee.getStart(file))
      .every((binding) => binding.offset === imported.getStart(file));
  });
}

function ownsBinding(
  name: string,
  scopes: readonly ts.Node[],
  offset: number,
  defs: Map<string, Binding[]>,
  file: ts.SourceFile,
  calls: readonly ts.CallExpression[],
): boolean {
  const target = visibleBindings(name, defs, scopes, offset)[0];
  if (target === undefined) return false;
  return calls.some((call) => {
    const argument = call.arguments[0];
    if (argument === undefined || !ts.isIdentifier(argument)) return false;
    const argumentOffset = argument.getStart(file);
    const argumentScopes = scopesAt(file, argumentOffset);
    return visibleBindings(argument.text, defs, argumentScopes, argumentOffset)[0] === target;
  });
}
function ownsFactoryResult(
  name: string,
  offset: number,
  defs: Map<string, Binding[]>,
  file: ts.SourceFile,
  calls: readonly ts.CallExpression[],
): boolean {
  let owned = false;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const initializer = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) && initializer.expression.text === name) {
        const callOffset = initializer.getStart(file);
        if (callOffset > offset && ownsBinding(node.name.text, scopesAt(file, callOffset), callOffset, defs, file, calls)) owned = true;
      }
    }
    if (!owned) ts.forEachChild(node, visit);
  };
  visit(file);
  return owned;
}
function factoryNameAt(file: ts.SourceFile, offset: number): string | undefined {
  let enclosing: ts.FunctionLikeDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (offset < node.getStart(file) || offset > node.end) return;
    if (ts.isFunctionLike(node) && "body" in node) enclosing = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (enclosing === undefined) return undefined;
  if (ts.isFunctionDeclaration(enclosing)) return enclosing.name?.text;
  const parent = enclosing.parent;
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : undefined;
}

function spawnIsOwnedByTeardown(offset: number, calls: readonly ts.CallExpression[], file: ts.SourceFile): boolean {
  return calls.some((call) => {
    const argument = call.arguments[0];
    return argument !== undefined && argument.getStart(file) <= offset && offset < argument.end;
  });
}

/** Remove balanced outer parentheses without interpreting the expression. */
function unwrapped(expr: string): string {
  let value = expr.trim();
  while (value.startsWith("(") && value.endsWith(")")) {
    let depth = 0;
    let quote: string | null = null;
    let enclosesAll = true;
    for (let i = 0; i < value.length; i++) {
      const c = value[i]!;
      if (quote !== null) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
      } else if (c === "'" || c === "\"" || c === "`") quote = c;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0 && i !== value.length - 1) {
        enclosesAll = false;
        break;
      }
    }
    if (!enclosesAll || depth !== 0) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

const IGNORED_IDS = new Set(["join", "resolve", "tmpdir", "mkdtempSync", "mkdirSync", "writeFileSync", "String", "process", "env"]);

type CallArgument = { readonly value: string; readonly scopes: readonly ts.Node[]; readonly offset: number };
type ParameterBinding = { readonly node: ts.Node; readonly name: string; readonly index: number; readonly property?: string; readonly scopes: readonly ts.Node[]; readonly args: CallArgument[] };
type FunctionResult = { readonly declaration: ts.Node; readonly name: string; readonly scopes: readonly ts.Node[]; readonly fields: Map<string, CallArgument[]> };

function reachesToken(
  expr: string,
  defs: Map<string, Binding[]>,
  params: readonly ParameterBinding[],
  results: readonly FunctionResult[],
  scopes: readonly ts.Node[],
  offset: number,
  seen = new Set<string>(),
): boolean {
  const value = unwrapped(expr);
  const branches = conditionalBranches(value);
  if (branches !== undefined) return branches.every((branch) =>
    branch === "undefined" || branch === "null" || reachesToken(branch, defs, params, results, scopes, offset, new Set(seen)));
  const fallback = splitTopLevel(value, "??");
  if (fallback.length > 1) return fallback.every((branch) =>
    reachesToken(branch, defs, params, results, scopes, offset, new Set(seen)));
  const returned = /^(?:await\s+)?\(?\s*([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\)?\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)$/.exec(value);
  if (returned !== null) {
    const candidates = results.filter((result) => result.name === returned[1]
      && result.scopes.length <= scopes.length
      && result.scopes.every((scope, index) => scopes[index] === scope));
    const depth = Math.max(0, ...candidates.map((result) => result.scopes.length));
    const nearest = candidates.filter((result) => result.scopes.length === depth);
    if (nearest.length > 0) {
      return nearest.every((result) => {
        const field = result.fields.get(returned[2]!) ?? [];
        const key = `return:${result.declaration.getStart()}:${returned[2]}`;
        if (seen.has(key) || field.length === 0) return false;
        const path = new Set(seen);
        path.add(key);
        return field.every((arg) => reachesToken(arg.value, defs, params, results, arg.scopes, arg.offset, path));
      });
    }
  }
  const ids = new Set(identifiers(expr));
  if (seen.size > 16) return false;
  for (const id of ids) {
    if (IGNORED_IDS.has(id)) continue;
    const local = visibleBindings(id, defs, scopes, offset);
    const localDepth = Math.max(0, ...local.map((binding) => binding.scopes.length));
    const parameters = params.filter((parameter) => parameter.name === id
      && parameter.scopes.length <= scopes.length
      && parameter.scopes.every((scope, index) => scopes[index] === scope));
    const parameterDepth = Math.max(0, ...parameters.map((parameter) => parameter.scopes.length));
    if (parameters.length > 0 && parameterDepth > localDepth) {
      const nearest = parameters.filter((parameter) => parameter.scopes.length === parameterDepth);
      if (nearest.some((parameter) => {
        const key = `${id}@param:${parameter.node.getStart()}`;
        if (seen.has(key) || parameter.args.length === 0) return false;
        const path = new Set(seen);
        path.add(key);
        return parameter.args.every((arg) => reachesToken(arg.value, defs, params, results, arg.scopes, arg.offset, path));
      })) return true;
      continue;
    }
    if (local.some((binding) => {
      if (binding.token) return true;
      const key = `${id}@${binding.offset}`;
      if (seen.has(key)) return false;
      const path = new Set(seen);
      path.add(key);
      return reachesToken(binding.value, defs, params, results, binding.valueScopes, binding.valueOffset, path);
    })) return true;
  }
  return false;
}

/** Callees that actually START a process. Anything else that merely NAMES the binary (`need(...)`,
 *  `locate(...)`, `commandExists(...)`, `resolveOnPath(...)`) is a PATH lookup or an availability
 *  check: it returns a string, never a child, so there is no broker to token and no handle to own.
 *  Counting those as spawn sites is not a harmless over-report. It produced edits that were type
 *  errors on their face (`teardownOnSignal(locate("nats-server"))` hands a string to a helper that
 *  wants a ChildProcess), which is what surfaced this. Matched on the callee's last segment so
 *  `child_process.spawn` and an aliased `spawn as spawnProc` are both covered. */
const SPAWNERS = new Set(["spawn", "spawnSync", "fork", "exec", "execSync", "execFile", "execFileSync"]);
function processAliases(file: ts.SourceFile): { names: Set<string>; namespaces: Set<string> } {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  const declarations: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && (node.moduleSpecifier.text === "node:child_process" || node.moduleSpecifier.text === "child_process")) {
      if (node.importClause?.name !== undefined) namespaces.add(node.importClause.name.text);
      const bindings = node.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (SPAWNERS.has(element.propertyName?.text ?? element.name.text)) names.add(element.name.text);
        }
      }
    }
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  const isRequire = (value: ts.Expression | undefined): boolean => value !== undefined
    && ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === "require"
    && value.arguments.length === 1 && ts.isStringLiteral(value.arguments[0]!)
    && (value.arguments[0]!.text === "node:child_process" || value.arguments[0]!.text === "child_process");
  let changed = true;
  const isDynamicImport = (value: ts.Expression | undefined): boolean => {
    const imported = value !== undefined && ts.isAwaitExpression(value) ? value.expression : value;
    return imported !== undefined && ts.isCallExpression(imported)
      && imported.expression.kind === ts.SyntaxKind.ImportKeyword
      && imported.arguments.length === 1 && ts.isStringLiteral(imported.arguments[0]!)
      && (imported.arguments[0]!.text === "node:child_process" || imported.arguments[0]!.text === "child_process");
  };
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      const value = declaration.initializer;
      if (ts.isIdentifier(declaration.name) && (isRequire(value) || isDynamicImport(value)) && !namespaces.has(declaration.name.text)) {
        namespaces.add(declaration.name.text);
        changed = true;
      } else if (ts.isIdentifier(declaration.name) && value !== undefined
        && ts.isIdentifier(value) && namespaces.has(value.text) && !namespaces.has(declaration.name.text)) {
        namespaces.add(declaration.name.text);
        changed = true;
      } else if (ts.isIdentifier(declaration.name) && value !== undefined
        && ts.isIdentifier(value) && names.has(value.text) && !names.has(declaration.name.text)) {
        names.add(declaration.name.text);
        changed = true;
      } else if (value !== undefined && ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression)
        && namespaces.has(value.expression.text) && SPAWNERS.has(value.name.text) && !names.has(declaration.name.getText(file))) {
        names.add(declaration.name.getText(file));
        changed = true;
      } else if (ts.isObjectBindingPattern(declaration.name)) {
        const namespace = value !== undefined && ts.isIdentifier(value) && namespaces.has(value.text)
          || isRequire(value) || isDynamicImport(value);
        if (!namespace) continue;
        for (const element of declaration.name.elements) {
          const property = element.propertyName ?? element.name;
          if (!ts.isIdentifier(element.name) || !ts.isIdentifier(property) || !SPAWNERS.has(property.text)) continue;
          const imported = value !== undefined && ts.isAwaitExpression(value) ? value.expression : value;
          const module = imported !== undefined && ts.isCallExpression(imported)
            && imported.expression.kind === ts.SyntaxKind.ImportKeyword
            && imported.arguments.length === 1 && ts.isStringLiteral(imported.arguments[0]!)
            ? imported.arguments[0]!.text
            : "";
          const childProcess = isRequire(value) || isDynamicImport(value) || module === "node:child_process" || module === "child_process"
            || value !== undefined && ts.isIdentifier(value) && namespaces.has(value.text);
          if (childProcess && !names.has(element.name.text)) {
            names.add(element.name.text);
            changed = true;
          }
        }
      }
    }
  }
  return { names, namespaces };
}
const isSpawner = (callee: string, aliases: { names: ReadonlySet<string>; namespaces: ReadonlySet<string> }): boolean => {
  if (aliases.names.has(callee)) return true;
  const member = /^(.*?)\.([A-Za-z_$][\w$]*)$/.exec(callee);
  return member !== null && aliases.namespaces.has(member[1]!) && SPAWNERS.has(member[2]!);
};

/** Identifiers in code, including template substitutions but excluding literal contents. */
function identifiers(expr: string): string[] {
  const file = ts.createSourceFile("expression.ts", `(${expr});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Split at top-level operator occurrences, ignoring literals and nested groups. */
function splitTopLevel(expr: string, operator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!;
    if (quote !== null) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; continue; }
    if (c === ")" || c === "]" || c === "}") { depth--; continue; }
    if (depth === 0 && expr.startsWith(operator, i)) {
      parts.push(expr.slice(start, i).trim());
      i += operator.length - 1;
      start = i + 1;
    }
  }
  if (parts.length === 0) return [expr.trim()];
  parts.push(expr.slice(start).trim());
  return parts;
}

/** Return the two branches of a simple top-level conditional expression. */
function conditionalBranches(expr: string): readonly [string, string] | undefined {
  let depth = 0;
  let quote: string | null = null;
  let question = -1;
  let nested = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!;
    if (quote !== null) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; continue; }
    if (c === ")" || c === "]" || c === "}") { depth--; continue; }
    if (depth !== 0) continue;
    if (c === "?" && expr[i + 1] !== "?" && expr[i + 1] !== ".") {
      if (question < 0) question = i;
      else nested++;
    } else if (c === ":" && question >= 0) {
      if (nested > 0) nested--;
      else return [expr.slice(question + 1, i).trim(), expr.slice(i + 1).trim()];
    }
  }
  return undefined;
}

function isNatsResolverCall(expr: string, defs: Map<string, Binding[]>, params: readonly ParameterBinding[], scopes: readonly ts.Node[], offset: number): boolean {
  const value = unwrapped(expr).replace(/^await\s+/, "").trim();
  const binding = visibleBindings("resolveNatsServer", defs, scopes, offset);
  const parameter = params.some((candidate) => candidate.name === "resolveNatsServer"
    && candidate.scopes.length <= scopes.length
    && candidate.scopes.every((scope, index) => scopes[index] === scope));
  return value === "resolveNatsServer()" && binding.length === 0 && !parameter;
}
/** Does an expression name the object returned by the local NATS resolver? */
function isNatsServerResult(
  expr: string,
  defs: Map<string, Binding[]>,
  params: readonly ParameterBinding[],
  scopes: readonly ts.Node[],
  offset: number,
  seen = new Set<string>(),
): boolean {
  const value = unwrapped(expr.replace(/^await\s+/, "")).trim();
  if (isNatsResolverCall(value, defs, params, scopes, offset)) return true;
  const member = /^(.*?)\s*(?:\?\.|\.)\s*bin$/.exec(value);
  if (member !== null) return isNatsResolverCall(member[1]!, defs, params, scopes, offset);
  if (!/^[A-Za-z_$][\w$]*$/.test(value) || seen.size > 16) return false;
  const bindings = visibleBindings(value, defs, scopes, offset);
  const candidates = params.filter((parameter) => parameter.name === value
    && parameter.scopes.length <= scopes.length
    && parameter.scopes.every((scope, index) => scopes[index] === scope));
  const localDepth = Math.max(0, ...bindings.map((binding) => binding.scopes.length));
  const parameterDepth = Math.max(0, ...candidates.map((parameter) => parameter.scopes.length));
  if (bindings.length > 0 && localDepth >= parameterDepth) {
    return bindings.some((binding) => {
      const key = `${value}@${binding.offset}`;
      return binding.value !== "" && !seen.has(key)
        && isNatsServerResult(binding.value, defs, params, binding.valueScopes, binding.valueOffset, new Set([...seen, key]));
    });
  }
  return candidates.filter((parameter) => parameter.scopes.length === parameterDepth)
    .some((parameter) => {
      const key = `${value}@param:${parameter.node.getStart()}`;
      return !seen.has(key) && parameter.args.some((arg) =>
        isNatsServerResult(arg.value, defs, params, arg.scopes, arg.offset, new Set([...seen, key])));
    });
}

/** Does an expression resolve to the broker binary through bounded local provenance. */
function resolvesNatsServer(
  expr: string,
  defs: Map<string, Binding[]>,
  params: readonly ParameterBinding[],
  scopes: readonly ts.Node[],
  offset: number,
  seen = new Set<string>(),
): boolean {
  const value = unwrapped(expr.replace(/\s*!$/, "").replace(/\s+as\s+[A-Za-z_$][\w$.]*(?:\[\])?$/, "")).trim();
  if (/^("|'|`)nats-server\1$/.test(value) || value === "nats-server") return true;
  if (isNatsResolverCall(value, defs, params, scopes, offset)) return false;
  const member = /^(.*?)\s*(?:\?\.|\.)\s*bin$/.exec(value);
  if (member !== null) return isNatsServerResult(member[1]!, defs, params, scopes, offset, new Set(seen));
  const fallback = splitTopLevel(value, "??");
  if (fallback.length > 1) return fallback.some((part) => resolvesNatsServer(part, defs, params, scopes, offset, new Set(seen)));
  const branches = conditionalBranches(value);
  if (branches !== undefined) return branches.some((part) => resolvesNatsServer(part, defs, params, scopes, offset, new Set(seen)));
  const lookup = /^(?:[A-Za-z_$][\w$]*\s*\(\s*)+("|'|`)nats-server\1\s*\)$/.exec(value);
  if (lookup !== null) return true;
  const call = /^([A-Za-z_$][\w$]*)\s*\((.*)\)$/.exec(value);
  if (call !== null) {
    const args = splitArgs(call[2]!);
    if (args.length !== 1 || !resolvesNatsServer(args[0]!, defs, params, scopes, offset, new Set(seen))) return false;
    return true;
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(value) || seen.size > 16) return false;
  const bindings = visibleBindings(value, defs, scopes, offset);
  const candidates = params.filter((parameter) => parameter.name === value
    && parameter.scopes.length <= scopes.length
    && parameter.scopes.every((scope, index) => scopes[index] === scope));
  const localDepth = Math.max(0, ...bindings.map((binding) => binding.scopes.length));
  const parameterDepth = Math.max(0, ...candidates.map((parameter) => parameter.scopes.length));
  if (bindings.length > 0 && localDepth >= parameterDepth) {
    return bindings.some((binding) => {
      const key = `${value}@${binding.offset}`;
      return binding.value !== "" && !seen.has(key)
        && resolvesNatsServer(binding.value, defs, params, binding.valueScopes, binding.valueOffset, new Set([...seen, key]));
    });
  }
  return candidates.filter((parameter) => parameter.scopes.length === parameterDepth)
    .some((parameter) => {
      const key = `${value}@param:${parameter.node.getStart()}`;
      return !seen.has(key) && parameter.args.some((arg) =>
        resolvesNatsServer(arg.value, defs, params, arg.scopes, arg.offset, new Set([...seen, key])));
    });
}
/** Each parameter and returned object field keeps only calls bound to its declaration. */
function functionProvenance(src: string, file: ts.SourceFile): { params: ParameterBinding[]; results: FunctionResult[] } {
  type FunctionInfo = {
    readonly declaration: ts.FunctionLikeDeclaration;
    readonly name: string;
    readonly scopes: readonly ts.Node[];
    readonly parameters: readonly ParameterBinding[];
    readonly fields: Map<string, CallArgument[]>;
  };
  const parameters: ParameterBinding[] = [];
  const functions: FunctionInfo[] = [];
  const calls: Array<{ readonly name: string; readonly scopes: readonly ts.Node[]; readonly args: readonly CallArgument[] }> = [];
  const visit = (node: ts.Node, parentScopes: readonly ts.Node[]): void => {
    const scopes = isLexicalScope(node) ? [...parentScopes, node] : parentScopes;
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        const names = ts.isIdentifier(parameter.name)
          ? [parameter.name.text]
          : ts.isObjectBindingPattern(parameter.name) || ts.isArrayBindingPattern(parameter.name)
            ? parameter.name.elements.flatMap((element) => ts.isOmittedExpression(element) ? []
              : ts.isIdentifier(element.name) ? [element.name.text] : [])
            : [];
        for (const name of names) {
          const element = ts.isObjectBindingPattern(parameter.name)
            ? parameter.name.elements.find((entry) => ts.isIdentifier(entry.name) && entry.name.text === name)
            : undefined;
          const property = element === undefined ? undefined : element.propertyName ?? element.name;
          parameters.push({ node: parameter, name, index: node.parameters.indexOf(parameter),
            property: property !== undefined && (ts.isIdentifier(property) || ts.isStringLiteral(property)) ? property.text : undefined,
            scopes, args: [] });
        }
      }
    }
    if (ts.isCatchClause(node) && node.variableDeclaration !== undefined && ts.isIdentifier(node.variableDeclaration.name)) {
      parameters.push({ node: node.variableDeclaration, name: node.variableDeclaration.name.text, index: -1, scopes, args: [] });
    }
    if (ts.isFunctionLike(node) && "body" in node && node.body !== undefined) {
      const parent = node.parent;
      const name = ts.isFunctionDeclaration(node) ? node.name?.text
        : ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text
        : ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && ts.isClassDeclaration(parent) && parent.name
          ? `${parent.name.text}.${node.name.text}`
        : ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && ts.isObjectLiteralExpression(parent)
          && ts.isVariableDeclaration(parent.parent) && ts.isIdentifier(parent.parent.name)
          ? `${parent.parent.name.text}.${node.name.text}`
        : undefined;
      if (name !== undefined) {
        const ownParameters = parameters.filter((parameter) => parameter.scopes === scopes);
        const fields = new Map<string, CallArgument[]>();
        const body = "body" in node ? node.body : undefined;
        if (body !== undefined && ts.isBlock(body)) {
          const collectReturn = (statement: ts.Node, parentScopes: readonly ts.Node[]): void => {
            if (statement !== body && ts.isFunctionLike(statement)) return;
            const statementScopes = isLexicalScope(statement) ? [...parentScopes, statement] : parentScopes;
            if (ts.isReturnStatement(statement) && statement.expression !== undefined && ts.isObjectLiteralExpression(statement.expression)) {
              for (const property of statement.expression.properties) {
                if (ts.isPropertyAssignment(property)) {
                  if (!(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) continue;
                  const value = src.slice(property.initializer.getStart(file), property.initializer.end);
                  const args = fields.get(property.name.text) ?? [];
                  args.push({ value, scopes: statementScopes, offset: property.initializer.getStart(file) });
                  fields.set(property.name.text, args);
                } else if (ts.isShorthandPropertyAssignment(property)) {
                  const args = fields.get(property.name.text) ?? [];
                  args.push({ value: property.name.text, scopes: statementScopes, offset: property.name.getStart(file) });
                  fields.set(property.name.text, args);
                }
              }
              return;
            }
            ts.forEachChild(statement, (child) => collectReturn(child, statementScopes));
          };
          collectReturn(body, scopes);
        }
        functions.push({ declaration: node, name, scopes: parentScopes, parameters: ownParameters, fields });
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      calls.push({
        name: node.expression.text,
        scopes: parentScopes,
        args: node.arguments.map((arg) => ({
          value: src.slice(arg.getStart(file), arg.end),
          scopes: scopesAt(file, arg.getStart(file)),
          offset: arg.getStart(file),
        })),
      });
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression;
      const name = ts.isIdentifier(receiver) ? `${receiver.text}.${node.expression.name.text}`
        : ts.isNewExpression(receiver) && ts.isIdentifier(receiver.expression)
          ? `${receiver.expression.text}.${node.expression.name.text}` : undefined;
      if (name !== undefined) calls.push({ name, scopes: parentScopes, args: node.arguments.map((arg) => ({
        value: src.slice(arg.getStart(file), arg.end), scopes: scopesAt(file, arg.getStart(file)), offset: arg.getStart(file),
      })) });
    }
    ts.forEachChild(node, (child) => visit(child, scopes));
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ["forEach", "map", "flatMap"].includes(node.expression.name.text)) {
      const callback = node.arguments[0];
      if (callback !== undefined && ts.isIdentifier(callback)) {
        calls.push({ name: callback.text, scopes: parentScopes, args: [{
          value: "", scopes, offset: callback.getStart(file),
        }] });
      }
    }
  };
  visit(file, []);
  for (const call of calls) {
    const candidates = functions.filter((fn) => fn.name === call.name
      && fn.scopes.length <= call.scopes.length
      && fn.scopes.every((scope, index) => call.scopes[index] === scope));
    const nearestDepth = Math.max(0, ...candidates.map((fn) => fn.scopes.length));
    for (const fn of candidates.filter((candidate) => candidate.scopes.length === nearestDepth)) {
      fn.parameters.forEach((parameter) => {
        const argument = call.args[parameter.index];
        if (argument === undefined) {
          parameter.args.push({ value: "", scopes: call.scopes, offset: call.args[0]?.offset ?? fn.declaration.getStart(file) });
          return;
        }
        if (parameter.property === undefined) { parameter.args.push(argument); return; }
        const parsed = ts.createSourceFile("argument.ts", `const argument = ${argument.value};`, ts.ScriptTarget.Latest, true);
        const statement = parsed.statements[0];
        const initializer = statement !== undefined && ts.isVariableStatement(statement)
          ? statement.declarationList.declarations[0]?.initializer : undefined;
        if (!initializer || !ts.isObjectLiteralExpression(initializer)) return;
        const member = initializer.properties.find((entry) => ts.isPropertyAssignment(entry)
          && (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) && entry.name.text === parameter.property);
        if (member !== undefined && ts.isPropertyAssignment(member)) parameter.args.push({
          ...argument,
          value: member.initializer.getText(parsed),
        });
      });
    }
  }
  return {
    params: parameters,
    results: functions.filter((fn) => fn.fields.size > 0).map((fn) => ({ declaration: fn.declaration, name: fn.name, scopes: fn.scopes, fields: fn.fields })),
  };
}

/** Every site, in `git ls-files` order. */
export function enumerateSpawnSites(cwd: string): SpawnSite[] {
  const files = execFileSync("git", ["ls-files", "*.ts", "*.mts", "*.cts", "*.mjs", "*.cjs", "*.js"], { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
    .split("\n")
    .filter((f) => f !== "");
  const sites: SpawnSite[] = [];
  for (const file of files) {
    let src: string;
    try { src = readFileSync(`${cwd}/${file}`, "utf8"); } catch { continue; }
    if (!src.includes("nats-server") && !src.includes("resolveNatsServer")) continue;
    const code = codeOnly(src);
    const { file: sourceFile, defs } = bindings(src);
    const { params, results } = functionProvenance(src, sourceFile);
    const aliases = processAliases(sourceFile);
    const commentFree = withoutComments(src, sourceFile);
    const teardownOwnershipCalls = teardownCalls(sourceFile, defs);
    const lineStarts = src.split("\n");
    const re = /([A-Za-z_$][\w$.]*)\s*\(/g;
    const matches: Array<{ callee: string; offset: number; open: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) matches.push({ callee: m[1]!, offset: m.index, open: code.indexOf("(", m.index + m[1]!.length) });
    const visitComputed = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isElementAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && ts.isStringLiteral(node.expression.argumentExpression)) {
        matches.push({ callee: `${node.expression.expression.text}.${node.expression.argumentExpression.text}`,
          offset: node.expression.getStart(sourceFile), open: node.arguments.pos - 1 });
      }
      ts.forEachChild(node, visitComputed);
    };
    visitComputed(sourceFile);
    for (const match of matches) {
      if (!isSpawner(match.callee, aliases)) continue;
      const open = match.open;
      const offset = match.offset;
      const body = open === -1 ? null : callBody(code, open);
      if (body === null) continue;
      const args = splitArgs(commentFree.slice(open + 1, open + 1 + body.length));
      const binaryExpr = args[0] ?? "";
      const scopes = scopesAt(sourceFile, offset);
      if (!resolvesNatsServer(binaryExpr, defs, params, scopes, offset)) continue;
      const line = code.slice(0, offset).split("\n").length;
      const brokerCode = args[1] ?? "";
      if (/--version/.test(brokerCode)) continue;
      const brokerArguments = splitArgs(brokerCode.replace(/^\[/, "").replace(/\]$/, ""));
      const sdIdx = brokerArguments.findIndex((x) => /^['"`]-sd['"`]$/.test(x));
      const cIdx = brokerArguments.findIndex((x) => /^['"`]-c['"`]$/.test(x));
      const idx = sdIdx >= 0 ? sdIdx : cIdx;
      const argvPath = sdIdx >= 0 ? "store" : cIdx >= 0 ? "config" : "none";
      const pathExpr = idx >= 0 ? brokerArguments[idx + 1] : undefined;
      const argvIndirect = argvPath === "none"
        && /^[A-Za-z_$][\w$]*$/.test(unwrapped(brokerCode.replace(/\s*!$/, "")).replace(/\s+as\s+[A-Za-z_$][\w$.]*(?:\[\])?$/, ""));
      const effectiveExpr = pathExpr ?? (argvIndirect ? brokerCode.trim() : undefined);
      const tokened = effectiveExpr !== undefined && reachesToken(effectiveExpr, defs, params, results, scopes, offset);
      // OWNERSHIP IS PER-SITE, NOT PER-FILE. A file that owns one of its two brokers would read as
      // clean under a file-level test, which is the same "named list" mistake one level down.
      //
      // Three shapes cover every site in this repo and they are graded differently:
      //   `const broker = spawn("nats-server", ...)` binds a name, so require THAT name reach
      //   `teardownOnSignal`. A sibling broker owned under a different name does not count.
      //   `const startBroker = () => spawn("nats-server", ...)` binds a FACTORY, and the handle its
      //   callers hold is what gets owned. Grading the factory's own name would report a suite that
      //   owns every broker it starts as unowned, so follow the call: a site is owned when some
      //   binding initialized from `startBroker(...)` reaches the helper. This is not hypothetical
      //   tidiness, it is a false positive this enumerator actually produced.
      //   `broker = trackChild(spawn("nats-server", ...))` passes the handle THROUGH a wrapper into
      //   a binding. The wrapper returns the child (that is what makes it a tracker), so the
      //   binding on the left is the handle, and grading it as unbound would report a suite that
      //   owns its broker correctly as unowned. Look past any wrapper calls to the assignment.
      //   `kids.push(spawn("nats-server", ...))` binds nothing, so there is no name to trace. The
      //   spawn is UNOWNED unless that expression is itself wrapped in the helper.
      const before = src.slice(0, offset);
      const tail = before.slice(-200);
      // Strip trailing wrapper openings (`= track("broker", ` / `= trackChild(`) so the assignment
      // underneath becomes visible, without letting the strip cross a statement boundary.
      const assignmentPrefix = tail.replace(/(?:[A-Za-z_$][\w$.]*\s*\(\s*(?:(['"`])[^'"`]*\1\s*,\s*)?)+$/, "");
      const bind = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:await\s+)?$|(?:^|[\s;{(])([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/.exec(assignmentPrefix);
      const name = bind?.[1] ?? bind?.[2];
      const factory = name === undefined ? factoryNameAt(sourceFile, offset) : undefined;
      const owned = name !== undefined
        ? ownsBinding(name, scopes, offset, defs, sourceFile, teardownOwnershipCalls)
        : factory !== undefined && ownsFactoryResult(factory, offset, defs, sourceFile, teardownOwnershipCalls)
          || spawnIsOwnedByTeardown(offset, teardownOwnershipCalls, sourceFile);
      // The exemption may need a paragraph of justification above the spawn, so the window is
      // generous. It is still bounded: a marker further away than this belongs to another site.
      const window = lineStarts.slice(Math.max(0, line - 12), line + 1).join("\n");
      sites.push({
        file,
        line,
        argvPath,
        ...(effectiveExpr === undefined ? {} : { pathExpr: effectiveExpr }),
        tokened,
        owned,
        shipped: !(TEST_RE.test(file) || TEST_FILE_RE.test(file)),
        exempt: window.includes(EXEMPT_MARKER),
      });
    }
  }
  return sites;
}
