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
  /** A function declaration, visible across its whole scope. */
  readonly hoisted: boolean;
  /** A declaration without an initializer: a placeholder, never a path a broker starts with. */
  readonly uninitialized: boolean;
  /** A conditional assignment leaves the previous value live outside the branch that may skip it. */
  alternative?: { readonly binding: Binding; readonly start: number; readonly end: number };
};

const SHORT_CIRCUIT: readonly ts.SyntaxKind[] = [
  ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
];

/** Every branch below `scope` that may skip `node`, innermost first. */
function skippableBranches(node: ts.Node, scope: ts.Node | undefined): ts.Node[] {
  const branches: ts.Node[] = [];
  for (let child = node, parent = node.parent; parent !== undefined && parent !== scope; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) break;
    if (ts.isIfStatement(parent) && child !== parent.expression) branches.push(child);
    else if (ts.isConditionalExpression(parent) && child !== parent.condition) branches.push(child);
    else if (ts.isBinaryExpression(parent) && child === parent.right && SHORT_CIRCUIT.includes(parent.operatorToken.kind)) branches.push(child);
    else if (ts.isIterationStatement(parent, false) && !ts.isDoStatement(parent) && child === parent.statement) branches.push(child);
    else if (ts.isCaseOrDefaultClause(parent) || ts.isCatchClause(parent)) branches.push(parent);
    else if (ts.isTryStatement(parent) && child === parent.tryBlock && parent.catchClause !== undefined) branches.push(child);
  }
  return branches;
}

/** The outermost branch below `scope` that may skip `node`, or undefined when `node` always runs. */
const skippableBranch = (node: ts.Node, scope: ts.Node | undefined): ts.Node | undefined => skippableBranches(node, scope).at(-1);

/** Collect local initializers without merging declarations from sibling scopes. */
function bindings(src: string): { file: ts.SourceFile; defs: Map<string, Binding[]> } {
  const file = ts.createSourceFile("source.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const defs = new Map<string, Binding[]>();
  const add = (name: string, binding: Binding): void => {
    const list = defs.get(name) ?? [];
    list.push(binding);
    defs.set(name, list);
  };
  const plain = { token: false, hoisted: false, uninitialized: false };
  const varAlternatives: Array<{ readonly name: string; readonly binding: Binding; readonly branch: ts.Node }> = [];
  const visit = (node: ts.Node, parentScopes: readonly ts.Node[]): void => {
    const scopes = isLexicalScope(node) ? [...parentScopes, node] : parentScopes;
    if (ts.isVariableDeclaration(node)) {
      const value = node.initializer === undefined ? "" : src.slice(node.initializer.getStart(file), node.initializer.end);
      const declarationScopes = node.parent.flags & ts.NodeFlags.BlockScoped
        ? scopes
        : scopes.filter((scope) => ts.isSourceFile(scope) || ts.isFunctionLike(scope));
      const valueOffset = node.initializer?.getStart(file) ?? node.getStart(file);
      const location = { scopes: declarationScopes, offset: node.getStart(file), valueScopes: scopes, valueOffset };
      // A for-of/for-in binding has no initializer but the loop always assigns it.
      const uninitialized = node.initializer === undefined && !ts.isForInStatement(node.parent.parent) && !ts.isForOfStatement(node.parent.parent);
      // A `var` initializer in a branch is a skippable write. Resolve its fallback after collecting assignments.
      const varBranch = node.initializer !== undefined && declarationScopes !== scopes
        ? skippableBranch(node, declarationScopes[declarationScopes.length - 1])
        : undefined;
      const addVariable = (name: string, binding: Binding): void => {
        add(name, binding);
        if (varBranch !== undefined) varAlternatives.push({ name, binding, branch: varBranch });
      };
      if (ts.isIdentifier(node.name)) addVariable(node.name.text, { ...plain, ...location, value, uninitialized });
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
          addVariable(element.name.text, { ...plain, ...location, token: kitToken,
            value: kitToken ? "" : value === "" ? "" : `(${value}).${property.text}` });
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
        const offset = node.getStart(file);
        add(node.name.text, { ...plain, value: "", scopes: [file], offset, valueScopes: [file], valueOffset: offset, token: true });
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      // The name belongs to the scope the declaration sits in, not to the function's own body.
      const declarationScopes = parentScopes.filter((scope) => ts.isSourceFile(scope) || ts.isFunctionLike(scope));
      const offset = node.getStart(file);
      add(node.name.text, { ...plain, value: "", scopes: declarationScopes, valueScopes: declarationScopes, valueOffset: offset, offset, hoisted: true });
    }

    ts.forEachChild(node, (child) => visit(child, scopes));
  };
  const collectAssignments = (node: ts.Node, parentScopes: readonly ts.Node[]): void => {
    const scopes = isLexicalScope(node) ? [...parentScopes, node] : parentScopes;
    const record = (target: ts.Identifier, assigned: string): void => {
      const visible = (defs.get(target.text) ?? []).filter((binding) =>
        binding.scopes.length <= scopes.length
        && binding.scopes.every((scope, index) => scopes[index] === scope)
        && (binding.scopes.length < scopes.length || binding.offset < node.getStart(file)),
      );
      const depth = Math.max(0, ...visible.map((binding) => binding.scopes.length));
      const nearest = visible.filter((binding) => binding.scopes.length === depth);
      const prior = nearest.length === 0 ? undefined : nearest.reduce((left, right) => left.offset > right.offset ? left : right);
      const targetScopes = prior?.scopes ?? scopes;
      const branch = prior === undefined ? undefined : skippableBranch(node, targetScopes[targetScopes.length - 1]);
      // The right side runs before the store, so it reads the previous value of a self-extending path.
      add(target.text, {
        ...plain,
        value: assigned,
        scopes: targetScopes,
        offset: node.getStart(file),
        valueScopes: scopes,
        valueOffset: node.getStart(file) - 1,
        ...(prior !== undefined && branch !== undefined
          ? { alternative: { binding: prior, start: branch.getStart(file), end: branch.end } }
          : {}),
      });
    };
    // Every identifier a destructuring pattern writes; its value is unproven.
    const patternTargets = (pattern: ts.Node): ts.Identifier[] => {
      if (ts.isIdentifier(pattern)) return [pattern];
      if (ts.isParenthesizedExpression(pattern) || ts.isSpreadElement(pattern) || ts.isSpreadAssignment(pattern)) return patternTargets(pattern.expression);
      if (ts.isBinaryExpression(pattern) && pattern.operatorToken.kind === ts.SyntaxKind.EqualsToken) return patternTargets(pattern.left);
      if (ts.isArrayLiteralExpression(pattern)) return pattern.elements.flatMap(patternTargets);
      if (ts.isObjectLiteralExpression(pattern)) return pattern.properties.flatMap((property) =>
        ts.isShorthandPropertyAssignment(property) ? [property.name]
          : ts.isPropertyAssignment(property) ? patternTargets(property.initializer)
          : ts.isSpreadAssignment(property) ? patternTargets(property.expression) : []);
      return [];
    };
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      record(node.left, src.slice(node.right.getStart(file), node.right.end));
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      for (const target of patternTargets(node.left)) record(target, "");
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstCompoundAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastCompoundAssignment && ts.isIdentifier(node.left)) {
      // Every compound operator but `+=` (and the logical ones) yields a number; any of them drops a path's token.
      const numeric = ![ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
        ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(node.operatorToken.kind);
      record(node.left, numeric ? "0" : "");
    } else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isIdentifier(node.operand)
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      record(node.operand, "0");
    } else if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
      for (const target of patternTargets(node.initializer)) record(target, "");
    }
    ts.forEachChild(node, (child) => collectAssignments(child, scopes));
  };
  visit(file, []);
  collectAssignments(file, []);
  for (const { name, binding, branch } of varAlternatives) {
    const prior = (defs.get(name) ?? []).filter((candidate) => candidate !== binding && candidate.offset < binding.offset
      && !contains(branch, candidate.offset)
      && candidate.scopes.length === binding.scopes.length
      && candidate.scopes.every((scope, index) => binding.scopes[index] === scope))
      .reduce<Binding | undefined>((latest, candidate) => latest === undefined || candidate.offset > latest.offset ? candidate : latest, undefined)
      ?? { ...plain, value: "", scopes: binding.scopes, offset: binding.offset, valueScopes: binding.valueScopes,
        valueOffset: binding.valueOffset, uninitialized: true };
    binding.alternative = { binding: prior, start: branch.getStart(file), end: branch.end };
  }
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

/** A function declaration is live from the start of its scope; every other binding from where it is written. */
const effectiveOffset = (binding: Binding): number => binding.hoisted ? -1 : binding.offset;

/** The latest of `candidates` live at `offset`, plus the earlier values a skippable assignment leaves live. */
function latestAt(candidates: readonly Binding[], offset: number): Binding[] {
  const before = candidates.filter((binding) => effectiveOffset(binding) <= offset);
  if (before.length === 0) return [];
  let current: Binding | undefined = before.reduce((left, right) => effectiveOffset(left) >= effectiveOffset(right) ? left : right);
  const live: Binding[] = [];
  while (current !== undefined) {
    live.push(current);
    const alternative: Binding["alternative"] = current.alternative;
    current = alternative !== undefined && (offset < alternative.start || offset >= alternative.end) ? alternative.binding : undefined;
  }
  return live;
}

/** The binding name a function is called through, or undefined for an anonymous function. */
function functionBinding(fn: ts.Node): { readonly name: string; readonly offset: number; readonly exported: boolean } | undefined {
  const exported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  if (ts.isFunctionDeclaration(fn) && fn.name !== undefined) return { name: fn.name.text, offset: fn.getStart(), exported: exported(fn) };
  const parent = fn.parent;
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return { name: parent.name.text, offset: parent.getStart(), exported: exported(parent.parent.parent) };
  }
  return undefined;
}

/** An identifier that reads a binding, not one that names a declaration, a property, or a type. */
function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === node;
  if (ts.isBindingElement(parent)) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)
    || ts.isPropertySignature(parent) || ts.isMethodSignature(parent) || ts.isVariableDeclaration(parent)
    || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)
    || ts.isClassDeclaration(parent) || ts.isImportSpecifier(parent) || ts.isImportClause(parent)) && parent.name === node) return false;
  return !ts.isTypeReferenceNode(parent) && !ts.isTypeQueryNode(parent) && !ts.isQualifiedName(parent);
}

const invocationCache = new WeakMap<ts.Node, readonly number[] | null>();

/** Offsets of every direct call to a local function, or null when it may run from code this file does not show. */
function invocations(fn: ts.Node, defs: Map<string, Binding[]>): readonly number[] | null {
  const cached = invocationCache.get(fn);
  if (cached !== undefined) return cached;
  let outer: ts.Node = fn;
  while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  const named = functionBinding(fn);
  let result: readonly number[] | null = null;
  const holder = outer.parent;
  const member = ts.isMethodDeclaration(fn) ? fn : ts.isPropertyAssignment(holder) && holder.initializer === outer ? holder : undefined;
  if (ts.isCallExpression(holder) && holder.expression === outer) result = [holder.getStart()];
  else if (member !== undefined && ts.isIdentifier(member.name) && ts.isObjectLiteralExpression(member.parent)
    && ts.isVariableDeclaration(member.parent.parent) && ts.isIdentifier(member.parent.parent.name)
    && member.parent.parent.initializer === member.parent) {
    // A property of a local object runs only through `object.property()`; an unreferenced object never runs it.
    const object = member.parent.parent;
    const statement = object.parent.parent;
    const exported = ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    const file = fn.getSourceFile();
    const property = member.name.text;
    const objectName = object.name.getText(file);
    const own = (defs.get(objectName) ?? []).find((binding) => binding.offset === object.getStart(file));
    if (!exported && own !== undefined) {
      const calls: number[] = [];
      let escapes = false;
      const visit = (node: ts.Node): void => {
        if (escapes) return;
        if (ts.isIdentifier(node) && node.text === objectName && isValueReference(node)
          && resolvedBindings(node.text, defs, scopesAt(file, node.getStart(file)), node.getStart(file)).includes(own)) {
          const access = node.parent;
          if (ts.isPropertyAccessExpression(access) && access.name.text === property
            && ts.isCallExpression(access.parent) && access.parent.expression === access) calls.push(access.parent.getStart(file));
          else if (!(ts.isPropertyAccessExpression(access) && access.name.text !== property)) escapes = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
      if (!escapes) result = calls;
    }
  } else if (named !== undefined && !named.exported) {
    const file = fn.getSourceFile();
    const sameName = defs.get(named.name) ?? [];
    const own = sameName.find((binding) => binding.offset === named.offset);
    // A reassigned function name may hold another function at a call, so its callers are unknown.
    const reassigned = own === undefined || sameName.some((binding) => binding !== own
      && binding.scopes.length === own.scopes.length && binding.scopes.every((scope, index) => own.scopes[index] === scope));
    if (own !== undefined && !reassigned) {
      const calls: number[] = [];
      let escapes = false;
      const visit = (node: ts.Node): void => {
        if (escapes) return;
        if (ts.isIdentifier(node) && node.text === named.name && isValueReference(node)) {
          const scopes = scopesAt(file, node.getStart(file));
          const resolved = sameName.filter((binding) => binding.scopes.length <= scopes.length
            && binding.scopes.every((scope, index) => scopes[index] === scope));
          const depth = Math.max(0, ...resolved.map((binding) => binding.scopes.length));
          if (resolved.includes(own) && depth === own.scopes.length) {
            if (ts.isCallExpression(node.parent) && node.parent.expression === node) calls.push(node.parent.getStart(file));
            else escapes = true;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
      if (!escapes) result = calls;
    }
  }
  invocationCache.set(fn, result);
  return result;
}

/** Every value a binding at scope depth `depth` may hold when `offset` runs, through the calls into enclosing functions. */
function liveAt(
  nearest: readonly Binding[],
  depth: number,
  scopes: readonly ts.Node[],
  offset: number,
  defs: Map<string, Binding[]>,
  stack: readonly ts.Node[],
): Binding[] {
  let index = -1;
  for (let i = scopes.length - 1; i >= depth; i--) if (ts.isFunctionLike(scopes[i]!)) { index = i; break; }
  if (index < 0) return latestAt(nearest, offset);
  const fn = scopes[index]!;
  const local = latestAt(nearest.filter((binding) => binding.offset >= fn.getStart() && binding.offset < fn.end), offset);
  if (local.length > 0) return local;
  if (stack.includes(fn)) return [];
  const calls = invocations(fn, defs);
  if (calls === null) {
    // An unseen caller may run the function at any point after it is written, so every later value is live too.
    const later = nearest.filter((binding) => binding.offset >= fn.end && !binding.hoisted);
    const before = latestAt(nearest, fn.getStart()).filter((binding) => later.length === 0 || !binding.uninitialized);
    return [...new Set([...before, ...later])];
  }
  const file = fn.getSourceFile();
  return [...new Set(calls
    .filter((call) => call < fn.getStart() || call >= fn.end)
    .flatMap((call) => liveAt(nearest, depth, scopesAt(file, call), call, defs, [...stack, fn])))];
}

/** The nearest-scope bindings a name refers to at `offset`, before asking which value is live. */
function resolvedBindings(name: string, defs: Map<string, Binding[]>, scopes: readonly ts.Node[], offset: number): Binding[] {
  const deferred = scopes.findIndex((scope) => ts.isFunctionLike(scope));
  const visible = (defs.get(name) ?? []).filter((binding) =>
    binding.scopes.length <= scopes.length
      && binding.scopes.every((scope, index) => scopes[index] === scope)
      && (effectiveOffset(binding) <= offset || deferred >= 0 && binding.scopes.length <= deferred),
  );
  const nearestScope = Math.max(0, ...visible.map((binding) => binding.scopes.length));
  return visible.filter((binding) => binding.scopes.length === nearestScope);
}

/** Every binding whose value a name may hold when `offset` runs. */
function visibleBindings(name: string, defs: Map<string, Binding[]>, scopes: readonly ts.Node[], offset: number): Binding[] {
  const nearest = resolvedBindings(name, defs, scopes, offset);
  if (nearest.length === 0) return [];
  return liveAt(nearest, nearest[0]!.scopes.length, scopes, offset, defs, []);
}

/** A parameter or catch binding of `name` encloses `scopes` more closely than the nearest local binding. */
function shadowedByParameter(name: string, params: readonly ParameterBinding[], scopes: readonly ts.Node[], localDepth: number): boolean {
  return params.some((parameter) => parameter.name === name
    && parameter.scopes.length > localDepth
    && parameter.scopes.length <= scopes.length
    && parameter.scopes.every((scope, index) => scopes[index] === scope));
}

/** Code at `offset` can run: each enclosing local function with known callers is called from code that can run. */
function reachable(file: ts.SourceFile, offset: number, defs: Map<string, Binding[]>, stack: readonly ts.Node[] = []): boolean {
  const scopes = scopesAt(file, offset);
  for (let i = scopes.length - 1; i >= 0; i--) {
    const fn = scopes[i]!;
    if (!ts.isFunctionLike(fn)) continue;
    const calls = invocations(fn, defs);
    if (calls === null) continue;
    if (stack.includes(fn)) return false;
    return calls.some((call) => (call < fn.getStart() || call >= fn.end) && reachable(file, call, defs, [...stack, fn]));
  }
  return true;
}

/** The deepest node that contains `offset`. */
function nodeAt(file: ts.SourceFile, offset: number): ts.Node {
  let found: ts.Node = file;
  const visit = (node: ts.Node): void => {
    if (offset < node.getStart(file) || offset >= node.end) return;
    found = node;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return found;
}

const contains = (node: ts.Node, offset: number): boolean => node.getStart() <= offset && offset < node.end;

/** The `&&` conjuncts a branch needs to run, or undefined for a branch whose condition is not a plain conjunction. */
function guardConjuncts(branch: ts.Node): ts.Expression[] | undefined {
  const parent = branch.parent;
  const condition = ts.isIfStatement(parent) && branch === parent.thenStatement ? parent.expression
    : ts.isConditionalExpression(parent) && branch === parent.whenTrue ? parent.condition
    : ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? parent.left
    : undefined;
  const split = (node: ts.Expression): ts.Expression[] => ts.isParenthesizedExpression(node) ? split(node.expression)
    : ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? [...split(node.left), ...split(node.right)]
    : [node];
  return condition === undefined ? undefined : split(condition);
}

/** An exit or loop transfer before registration can bypass it. */
function exitsBetween(file: ts.SourceFile, fn: ts.Node, spawnOffset: number, callOffset: number): boolean {
  const spawn = nodeAt(file, spawnOffset);
  let found = false;
  const exclusive = (left: ts.Node, right: ts.Node): boolean => {
    const parent = left.parent;
    return parent !== undefined && right.parent === parent
      && (ts.isIfStatement(parent) && (left === parent.thenStatement && right === parent.elseStatement
        || left === parent.elseStatement && right === parent.thenStatement)
        || ts.isConditionalExpression(parent) && (left === parent.whenTrue && right === parent.whenFalse
          || left === parent.whenFalse && right === parent.whenTrue));
  };
  const transferTarget = (node: ts.BreakStatement | ts.ContinueStatement): ts.Node | undefined => {
    if (node.label !== undefined) {
      for (let parent = node.parent; parent !== undefined && parent !== fn; parent = parent.parent) {
        if (ts.isLabeledStatement(parent) && parent.label.text === node.label.text) return parent.statement;
      }
      return undefined;
    }
    for (let parent = node.parent; parent !== undefined && parent !== fn; parent = parent.parent) {
      if (ts.isIterationStatement(parent, false) || ts.isBreakStatement(node) && ts.isSwitchStatement(parent)) return parent;
    }
    return undefined;
  };
  const exits = (node: ts.Node): boolean => ts.isReturnStatement(node) || ts.isThrowStatement(node)
    || ts.isBreakStatement(node) || ts.isContinueStatement(node)
    || ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "process"
      && node.expression.name.text === "exit";
  const visit = (node: ts.Node): void => {
    if (found || node !== fn && ts.isFunctionLike(node)) return;
    if (exits(node) && node.getStart(file) > spawnOffset && node.end < callOffset) {
      const transferLeavesRegistration = (ts.isBreakStatement(node) || ts.isContinueStatement(node))
        && transferTarget(node) !== undefined && contains(transferTarget(node)!, callOffset);
      const terminalExit = ts.isReturnStatement(node) || ts.isThrowStatement(node)
        || ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "process";
      const exitBranches = skippableBranches(node, fn);
      const spawnBranches = skippableBranches(spawn, fn);
      if ((terminalExit || transferLeavesRegistration)
        && !exitBranches.some((exit) => spawnBranches.some((started) => exclusive(exit, started)))) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return found;
}

const functionNodes = new WeakMap<ts.SourceFile, ReadonlyMap<string, ts.Node>>();

/** Resolve a local call to its function declaration or function-valued variable. */
function calledFunction(call: ts.CallExpression, defs: Map<string, Binding[]>): ts.Node | undefined {
  if (!ts.isIdentifier(call.expression)) return undefined;
  const file = call.getSourceFile();
  let nodes = functionNodes.get(file);
  if (nodes === undefined) {
    const collected = new Map<string, ts.Node>();
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node)) {
        const binding = functionBinding(node);
        if (binding !== undefined) collected.set(`${binding.name}:${binding.offset}`, node);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    nodes = collected;
    functionNodes.set(file, nodes);
  }
  const offset = call.expression.getStart(file);
  const bindings = resolvedBindings(call.expression.text, defs, scopesAt(file, offset), offset);
  return bindings.length === 1 ? nodes.get(`${call.expression.text}:${bindings[0]!.offset}`) : undefined;
}

/** Whether code between this spawn and teardown can re-enter its function. */
function reentersBeforeTeardown(
  file: ts.SourceFile,
  fn: ts.Node,
  spawnOffset: number,
  callOffset: number,
  defs: Map<string, Binding[]>,
  stack: readonly ts.Node[] = [],
): boolean {
  if (stack.includes(fn)) return true;
  const visit = (node: ts.Node, start: number, end: number): boolean => {
    if (node !== fn && ts.isFunctionLike(node)) return false;
    if (ts.isCallExpression(node) && node.getStart(file) > start && node.getStart(file) < end) {
      const target = calledFunction(node, defs);
      if (target === fn) return true;
      if (target !== undefined && reentersBeforeTeardown(file, target, target.getStart(file), target.end, defs, [...stack, fn])) return true;
    }
    return ts.forEachChild(node, (child) => visit(child, start, end)) ?? false;
  };
  return visit(fn, spawnOffset, callOffset);
}
/** A call is repeated when its site or any caller runs in a loop without the registration. */
function callRepeats(file: ts.SourceFile, fn: ts.Node, registrationOffset: number, defs: Map<string, Binding[]>, stack: readonly ts.Node[] = []): boolean {
  if (stack.includes(fn)) return true;
  const calls = invocations(fn, defs);
  if (calls === null) return true;
  return calls.some((caller) => {
    if (contains(fn, caller)) return false;
    let site: ts.Node = nodeAt(file, caller);
    while (!ts.isCallExpression(site) && site.parent !== undefined && site.parent.getStart(file) === caller) site = site.parent;
    if (!ts.isCallExpression(site)) return true;
    let parentFunction: ts.Node | undefined;
    for (let node = site.parent; node !== undefined; node = node.parent) {
      if (ts.isIterationStatement(node, false) && !contains(node, registrationOffset)) return true;
      if (ts.isFunctionLike(node)) { parentFunction = node; break; }
    }
    return parentFunction !== undefined && callRepeats(file, parentFunction, registrationOffset, defs, [...stack, fn]);
  });
}
/** The registration at `call` runs once per broker spawned at `spawnOffset`. */
function coRuns(file: ts.SourceFile, spawnOffset: number, call: ts.CallExpression, defs: Map<string, Binding[]>, stack: readonly ts.Node[] = []): boolean {
  for (let node = nodeAt(file, spawnOffset); node.parent !== undefined && !ts.isFunctionLike(node); node = node.parent) {
    if (ts.isIterationStatement(node, false) && !contains(node, call.getStart(file))) return false;
  }
  const child = call.arguments[0];
  const spawnGuards = skippableBranches(nodeAt(file, spawnOffset), undefined).flatMap((branch) => guardConjuncts(branch) ?? []);
  const single = (id: ts.Identifier): boolean => {
    const offset = id.getStart(file);
    const nearest = resolvedBindings(id.text, defs, scopesAt(file, offset), offset);
    const own = nearest[0];
    return nearest.length === 1 && own !== undefined && (defs.get(id.text) ?? []).filter((binding) =>
      binding.scopes.length === own.scopes.length && binding.scopes.every((scope, index) => own.scopes[index] === scope)).length === 1;
  };
  const implied = (conjunct: ts.Expression): boolean => ts.isIdentifier(conjunct) && (
    child !== undefined && ts.isIdentifier(child) && conjunct.text === child.text
    || single(conjunct) && spawnGuards.some((guard) => ts.isIdentifier(guard) && guard.text === conjunct.text));
  if (skippableBranches(call, undefined).some((branch) => !contains(branch, spawnOffset)
    && !(guardConjuncts(branch)?.every(implied) ?? false))) return false;
  let spawnFunction: ts.Node | undefined = nodeAt(file, spawnOffset).parent;
  while (spawnFunction !== undefined && !ts.isFunctionLike(spawnFunction)) spawnFunction = spawnFunction.parent;
  const childBinding = child !== undefined && ts.isIdentifier(child)
    ? visibleBindings(child.text, defs, scopesAt(file, spawnOffset), spawnOffset)[0]
    : undefined;
  if (spawnFunction !== undefined && childBinding !== undefined && !childBinding.scopes.includes(spawnFunction)
    && reentersBeforeTeardown(file, spawnFunction, spawnOffset, call.getStart(file), defs)) return false;
  let callFunction: ts.Node | undefined = call.parent;
  while (callFunction !== undefined && !ts.isFunctionLike(callFunction)) callFunction = callFunction.parent;
  if (spawnFunction !== undefined && !contains(spawnFunction, call.getStart(file))) {
    const launches = invocations(spawnFunction, defs);
    if (launches === null || launches.length !== 1) return false;
    if (callRepeats(file, spawnFunction, call.getStart(file), defs)) return false;
  }
  if (callFunction !== undefined && contains(callFunction, spawnOffset)
    && exitsBetween(file, callFunction, spawnOffset, call.getStart(file))) return false;
  if (callFunction === undefined || contains(callFunction, spawnOffset)) return true;
  const calls = invocations(callFunction, defs);
  if (calls === null) return true;
  if (stack.includes(callFunction)) return false;
  return calls.some((caller) => {
    let site: ts.Node = nodeAt(file, caller);
    while (!ts.isCallExpression(site) && site.parent !== undefined && site.parent.getStart(file) === caller) site = site.parent;
    return !contains(callFunction, caller) && ts.isCallExpression(site) && coRuns(file, spawnOffset, site, defs, [...stack, callFunction]);
  });
}

/** A call that stops a child: the evidence a later release no longer drops a live broker. */
const KILL_EVIDENCE = /kill|exit|^stop(?:owned|broker)/i;

/** `node` holds a kill-evidence call inside [start, end) that runs where it is written. */
function killsBetween(node: ts.Node, start: number, end: number, file: ts.SourceFile): boolean {
  if (node.getStart(file) >= end || node.end <= start) return false;
  // A nested function counts only as an inline callback (`kids.map((k) => k.kill())`), which runs where it is written.
  if (ts.isFunctionLike(node) && !ts.isCallExpression(node.parent)) return false;
  if (ts.isCallExpression(node) && node.getStart(file) >= start && node.end <= end) {
    const callee = node.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
    if (KILL_EVIDENCE.test(name)) return true;
  }
  return ts.forEachChild(node, (child) => killsBetween(child, start, end, file) || undefined) ?? false;
}

function containsAwait(node: ts.Node): boolean {
  if (ts.isAwaitExpression(node)) return true;
  if (ts.isFunctionLike(node)) return false;
  return ts.forEachChild(node, (child) => containsAwait(child) || undefined) ?? false;
}

/**
 * The helper's returned release runs while the broker may still be live: called directly, or called
 * later in the registering function body with no kill before it and no synchronous kill right after it.
 */
function releasedEarly(file: ts.SourceFile, call: ts.CallExpression, defs: Map<string, Binding[]>): boolean {
  let outer: ts.Node = call;
  while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  if (ts.isCallExpression(outer.parent) && outer.parent.expression === outer) return true;
  const holder = outer.parent;
  const name = ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) && holder.initializer === outer ? holder.name
    : ts.isBinaryExpression(holder) && holder.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(holder.left) && holder.right === outer
      ? holder.left : undefined;
  if (name === undefined) return false;
  const record = (defs.get(name.text) ?? []).find((binding) => binding.offset === holder.getStart(file));
  if (record === undefined) return false;
  let body: ts.Node = call;
  while (body.parent !== undefined && !ts.isFunctionLike(body)) body = body.parent;
  const killedIn = (start: number, end: number): boolean =>
    ts.forEachChild(body, (child) => killsBetween(child, start, end, file) || undefined) ?? false;
  let early = false;
  const visit = (node: ts.Node): void => {
    if (early || node !== body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name.text
      && node.getStart(file) > call.end
      && resolvedBindings(name.text, defs, scopesAt(file, node.getStart(file)), node.getStart(file)).includes(record)) {
      // `release(); broker.kill();` leaves no turn of the event loop in which a signal could land.
      let statement: ts.Node = node;
      while (statement.parent !== body && !ts.isBlock(statement.parent) && !ts.isSourceFile(statement.parent)) statement = statement.parent;
      const container = statement.parent;
      const siblings = ts.isBlock(container) || ts.isSourceFile(container) ? container.statements : undefined;
      const next = siblings?.[siblings.findIndex((sibling) => sibling === statement) + 1];
      const killedAfter = next !== undefined && !containsAwait(next) && killsBetween(next, next.getStart(file), next.end, file);
      if (!killedIn(call.end, node.getStart(file)) && !killedAfter) early = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return early;
}

function teardownCalls(file: ts.SourceFile, defs: Map<string, Binding[]>, params: readonly ParameterBinding[]): ts.CallExpression[] {
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
    const offset = callee.getStart(file);
    const scopes = scopesAt(file, offset);
    const local = resolvedBindings(callee.text, defs, scopes, offset);
    const localDepth = Math.max(0, ...local.map((binding) => binding.scopes.length));
    // The helper must be the import itself, not a same-name local or parameter, the call must be able
    // to run, and its release must not drop the broker while it is live.
    return local.every((binding) => binding.offset === imported.getStart(file))
      && !shadowedByParameter(callee.text, params, scopes, localDepth)
      && reachable(file, offset, defs)
      && !releasedEarly(file, call, defs);
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
    const held = visibleBindings(argument.text, defs, scopesAt(file, argumentOffset), argumentOffset)
      .filter((binding) => !binding.uninitialized);
    // A declared-but-unassigned value is `undefined`, never a different child.
    return held.length > 0 && held.every((binding) => binding === target) && coRuns(file, offset, call, defs);
  });
}
/** Some call that resolves to THIS factory binding, not a same-name one, hands its result to the helper. */
function ownsFactoryResult(
  factory: { readonly name: string; readonly offset: number },
  offset: number,
  defs: Map<string, Binding[]>,
  file: ts.SourceFile,
  calls: readonly ts.CallExpression[],
): boolean {
  let owned = false;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const initializer = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) && initializer.expression.text === factory.name) {
        const callOffset = initializer.getStart(file);
        const callScopes = scopesAt(file, callOffset);
        const callee = resolvedBindings(factory.name, defs, callScopes, callOffset);
        if (callOffset > offset && callee.length > 0 && callee.every((binding) => binding.offset === factory.offset)
          && ownsBinding(node.name.text, callScopes, callOffset, defs, file, calls)) owned = true;
      }
    }
    if (!owned) ts.forEachChild(node, visit);
  };
  visit(file);
  return owned;
}
function factoryAt(file: ts.SourceFile, offset: number): { readonly name: string; readonly offset: number } | undefined {
  let enclosing: ts.FunctionLikeDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (offset < node.getStart(file) || offset > node.end) return;
    if (ts.isFunctionLike(node) && "body" in node) enclosing = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return enclosing === undefined ? undefined : functionBinding(enclosing);
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

/** Path builders whose result keeps a tokened argument, while every later segment is a plain relative name. */
const PATH_PRESERVING: Readonly<Record<string, readonly string[]>> = {
  "node:path": ["join", "resolve"],
  "node:fs": ["mkdtempSync", "realpathSync"],
};

/** A later path segment that cannot climb out of, or replace, the tokened prefix; each `${}` span must be proven safe. */
function keepsPrefix(node: ts.Expression, spanSafe: (span: ts.Expression) => boolean): boolean {
  const relative = (text: string): boolean => !/^([\\/]|[A-Za-z]:)/.test(text) && !text.split(/[\\/]/).includes("..");
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return relative(node.text);
  if (!ts.isTemplateExpression(node) || !node.templateSpans.every((span) => spanSafe(span.expression))) return false;
  // A proven span holds no separator, colon, or dot, so it is either empty or a plain name: try both, and
  // refuse any colon, since a span beside it could complete a drive letter.
  const parts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
  return !parts.some((part) => part.includes(":")) && relative(parts.join("x")) && relative(parts.join(""));
}

const NUMERIC_OPERATORS: readonly ts.SyntaxKind[] = [
  ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken,
];

/** Path-builder names bound by an import, each with the local binding offset a dynamic import gives it. */
function pathPreservingNames(file: ts.SourceFile): Map<string, number | undefined> {
  const names = new Map<string, number | undefined>();
  const moduleName = (text: string): string => text.startsWith("node:") ? text : `node:${text}`;
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const preserving = PATH_PRESERVING[moduleName(statement.moduleSpecifier.text)];
      const named = statement.importClause?.namedBindings;
      if (preserving === undefined || named === undefined || !ts.isNamedImports(named)) continue;
      for (const element of named.elements) {
        if (preserving.includes(element.propertyName?.text ?? element.name.text)) names.set(element.name.text, undefined);
      }
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer !== undefined && ts.isAwaitExpression(declaration.initializer)
        ? declaration.initializer.expression : undefined;
      if (!ts.isObjectBindingPattern(declaration.name) || initializer === undefined || !ts.isCallExpression(initializer)
        || initializer.expression.kind !== ts.SyntaxKind.ImportKeyword || initializer.arguments.length !== 1) continue;
      const specifier = initializer.arguments[0]!;
      const preserving = ts.isStringLiteral(specifier) ? PATH_PRESERVING[moduleName(specifier.text)] : undefined;
      if (preserving === undefined) continue;
      for (const element of declaration.name.elements) {
        const property = element.propertyName ?? element.name;
        if (ts.isIdentifier(element.name) && ts.isIdentifier(property) && preserving.includes(property.text)) {
          names.set(element.name.text, declaration.getStart(file));
        }
      }
    }
  }
  return names;
}

type CallArgument = { readonly value: string; readonly scopes: readonly ts.Node[]; readonly offset: number };
type ParameterBinding = { readonly node: ts.Node; readonly name: string; readonly index: number; readonly property?: string; readonly scopes: readonly ts.Node[]; readonly args: CallArgument[] };
type FunctionResult = { readonly declaration: ts.Node; readonly name: string; readonly scopes: readonly ts.Node[]; readonly fields: Map<string, CallArgument[]> };
type Provenance = {
  readonly defs: Map<string, Binding[]>;
  readonly params: readonly ParameterBinding[];
  readonly results: readonly FunctionResult[];
  /** Imported path builders by local name, with the dynamic-import binding offset when there is one. */
  readonly preserving: ReadonlyMap<string, number | undefined>;
};

/**
 * Does the token survive into the VALUE of `expr` on every path, not merely appear in it? Only shapes
 * known to keep their input count: concatenation, template substitution, the imported path builders, and
 * bindings whose every live value carries it. Any other call or member read is unproven.
 */
function reachesToken(
  expr: string,
  context: Provenance,
  scopes: readonly ts.Node[],
  offset: number,
  seen = new Set<string>(),
): boolean {
  const value = unwrapped(expr);
  if (seen.size > 16) return false;
  const returned = /^(?:await\s+)?\(?\s*([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\)?\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)$/.exec(value);
  if (returned !== null) {
    // The call must resolve to the recorded declaration itself, never a same-name parameter or shadow.
    const callee = resolvedBindings(returned[1]!, context.defs, scopes, offset);
    const calleeDepth = Math.max(0, ...callee.map((binding) => binding.scopes.length));
    if (callee.length === 0 || shadowedByParameter(returned[1]!, context.params, scopes, calleeDepth)) return false;
    const nearest = context.results.filter((result) => result.name === returned[1]
      && callee.every((binding) => binding.offset === functionBinding(result.declaration)?.offset));
    if (nearest.length > 0) {
      return nearest.every((result) => {
        const field = result.fields.get(returned[2]!) ?? [];
        const key = `return:${result.declaration.getStart()}:${returned[2]}`;
        if (seen.has(key) || field.length === 0) return false;
        const path = new Set(seen);
        path.add(key);
        return field.every((arg) => reachesToken(arg.value, context, arg.scopes, arg.offset, path));
      });
    }
  }
  const parsed = ts.createSourceFile("expression.ts", `(${value});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = parsed.statements[0];
  if (statement === undefined || !ts.isExpressionStatement(statement) || parsed.statements.length !== 1) return false;
  const survives = (node: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
      || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) || ts.isAwaitExpression(node)) return survives(node.expression);
    if (ts.isConditionalExpression(node)) return [node.whenTrue, node.whenFalse].every((branch) =>
      branch.kind === ts.SyntaxKind.NullKeyword || ts.isIdentifier(branch) && branch.text === "undefined" || survives(branch));
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      // Either operand of a short circuit can be the result, so both have to carry the token.
      if (SHORT_CIRCUIT.includes(operator)) return survives(node.left) && survives(node.right);
      if (operator === ts.SyntaxKind.PlusToken) return survives(node.left) || survives(node.right);
      if (operator === ts.SyntaxKind.CommaToken) return survives(node.right);
      return false;
    }
    if (ts.isTemplateExpression(node)) return node.templateSpans.some((span) => survives(span.expression));
    if (ts.isArrayLiteralExpression(node)) return node.elements.some((element) => !ts.isSpreadElement(element) && survives(element));
    if (ts.isCallExpression(node)) {
      if (!ts.isIdentifier(node.expression) || !preservingCallee(node.expression.text)) return false;
      const args = node.arguments;
      const spanSafe = (span: ts.Expression): boolean => plainSegment(span.getText(parsed), context, scopes, offset, seen);
      // A tokened segment survives only when nothing after it can replace or climb out of it.
      return args.some((argument, index) => !ts.isSpreadElement(argument) && survives(argument)
        && args.slice(index + 1).every((later) => keepsPrefix(later, spanSafe)));
    }
    if (ts.isIdentifier(node)) return everyValue(node.text, context, scopes, offset, seen, true,
      (arg, path) => reachesToken(arg.value, context, arg.scopes, arg.offset, path));
    return false;
  };
  const preservingCallee = (name: string): boolean => {
    const local = resolvedBindings(name, context.defs, scopes, offset);
    if (shadowedByParameter(name, context.params, scopes, Math.max(0, ...local.map((binding) => binding.scopes.length)))) return false;
    if (local.length > 0) {
      const imported = context.preserving.get(name);
      return imported !== undefined && local.every((binding) => binding.offset === imported);
    }
    // An unimported builder name with no local binding is a fixture's elided import.
    return context.preserving.has(name) || Object.values(PATH_PRESERVING).some((names) => names.includes(name));
  };
  return survives(statement.expression);
}

/** Every value `id` may hold at `offset`, through its live local bindings or the parameter it names, passes `accept`. */
function everyValue(
  id: string,
  context: Provenance,
  scopes: readonly ts.Node[],
  offset: number,
  seen: ReadonlySet<string>,
  tokenAccepted: boolean,
  accept: (value: CallArgument, path: Set<string>) => boolean,
): boolean {
  const local = visibleBindings(id, context.defs, scopes, offset);
  const localDepth = Math.max(0, ...local.map((binding) => binding.scopes.length));
  const parameters = context.params.filter((parameter) => parameter.name === id
    && parameter.scopes.length <= scopes.length
    && parameter.scopes.every((scope, index) => scopes[index] === scope));
  const parameterDepth = Math.max(0, ...parameters.map((parameter) => parameter.scopes.length));
  if (parameters.length > 0 && parameterDepth > localDepth) {
    return parameters.filter((parameter) => parameter.scopes.length === parameterDepth).some((parameter) => {
      const key = `${id}@param:${parameter.node.getStart()}`;
      if (seen.has(key) || parameter.args.length === 0) return false;
      const path = new Set(seen);
      path.add(key);
      return parameter.args.every((arg) => accept(arg, path));
    });
  }
  return local.length > 0 && local.every((binding) => {
    if (binding.token) return tokenAccepted;
    if (binding.uninitialized || binding.value === "") return false;
    const key = `${id}@${binding.offset}`;
    if (seen.has(key)) return false;
    const path = new Set(seen);
    path.add(key);
    return accept({ value: binding.value, scopes: binding.valueScopes, offset: binding.valueOffset }, path);
  });
}

/** `/[^a-z0-9_-]/g`-style class: the characters a `replace(class, "")` leaves are only letters, digits, `_`, `-`. */
function stripsToName(regex: string): boolean {
  const match = /^\/\[\^([^\]]*)\]\/([a-z]*)$/.exec(regex);
  if (match === null || !match[2]!.includes("g")) return false;
  const kept = match[1]!.replace(/^-|-$/g, "");
  return /^(?:[a-z]-[a-z]|[A-Z]-[A-Z]|[0-9]-[0-9]|[A-Za-z0-9_])*$/.test(kept);
}

/** A template span value that is a plain name or a number: no separator, colon, or dot-only segment. */
function plainSegment(expr: string, context: Provenance, scopes: readonly ts.Node[], offset: number, seen: ReadonlySet<string>): boolean {
  if (seen.size > 16) return false;
  const parsed = ts.createSourceFile("segment.ts", `(${unwrapped(expr)});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = parsed.statements[0];
  if (statement === undefined || !ts.isExpressionStatement(statement) || parsed.statements.length !== 1) return false;
  const plain = (node: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
      || ts.isSatisfiesExpression(node)) return plain(node.expression);
    if (ts.isNumericLiteral(node)) return true;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return /^[A-Za-z0-9_-]*$/.test(node.text);
    if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]
      .every((part) => /^[A-Za-z0-9_-]*$/.test(part)) && node.templateSpans.every((span) => plain(span.expression));
    // Arithmetic and `.length` always yield a number, which cannot name a separator or a parent.
    if (ts.isPrefixUnaryExpression(node)) return node.operator !== ts.SyntaxKind.ExclamationToken;
    if (ts.isBinaryExpression(node)) {
      if (NUMERIC_OPERATORS.includes(node.operatorToken.kind)) return true;
      return node.operatorToken.kind === ts.SyntaxKind.PlusToken && plain(node.left) && plain(node.right);
    }
    if (ts.isPropertyAccessExpression(node)) return node.name.text === "length";
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "replace"
      && node.arguments.length === 2 && ts.isRegularExpressionLiteral(node.arguments[0]!)) {
      const replacement = node.arguments[1]!;
      return stripsToName(node.arguments[0]!.text) && (ts.isStringLiteral(replacement) || ts.isNoSubstitutionTemplateLiteral(replacement))
        && /^[A-Za-z0-9_-]*$/.test(replacement.text);
    }
    if (ts.isIdentifier(node)) return everyValue(node.text, context, scopes, offset, seen, false,
      (arg, path) => plainSegment(arg.value, context, arg.scopes, arg.offset, path));
    return false;
  };
  return plain(statement.expression);
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
/** The function names a for-of array-destructured binding takes from a literal array of tuples, or none. */
function tupleAliasTargets(callee: ts.Identifier): string[] {
  let scope: ts.Node | undefined = callee.parent;
  while (scope !== undefined && !ts.isForOfStatement(scope)) scope = ts.isFunctionLike(scope) ? undefined : scope.parent;
  for (; scope !== undefined; scope = scope.parent) {
    if (!ts.isForOfStatement(scope) || !ts.isVariableDeclarationList(scope.initializer)) continue;
    const pattern = scope.initializer.declarations[0]?.name;
    if (pattern === undefined || !ts.isArrayBindingPattern(pattern)) continue;
    const index = pattern.elements.findIndex((element) => ts.isBindingElement(element) && ts.isIdentifier(element.name) && element.name.text === callee.text);
    if (index < 0) continue;
    let list: ts.Expression = scope.expression;
    while (ts.isAsExpression(list) || ts.isParenthesizedExpression(list) || ts.isSatisfiesExpression(list)) list = list.expression;
    if (!ts.isArrayLiteralExpression(list)) return [];
    return list.elements.flatMap((row) => {
      const entry = ts.isArrayLiteralExpression(row) ? row.elements[index] : undefined;
      return entry !== undefined && ts.isIdentifier(entry) ? [entry.text] : [];
    });
  }
  return [];
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
      const args = node.arguments.map((arg) => ({
        value: src.slice(arg.getStart(file), arg.end),
        scopes: scopesAt(file, arg.getStart(file)),
        offset: arg.getStart(file),
      }));
      calls.push({ name: node.expression.text, scopes: parentScopes, args });
      // `for (const [, start] of [["a", startA], ["b", startB]])` calls each listed function through `start`.
      for (const name of tupleAliasTargets(node.expression)) calls.push({ name, scopes: parentScopes, args });
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
    const teardownOwnershipCalls = teardownCalls(sourceFile, defs, params);
    const provenance = { defs, params, results, preserving: pathPreservingNames(sourceFile) };
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
      const tokened = effectiveExpr !== undefined && reachesToken(effectiveExpr, provenance, scopes, offset);
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
      const factory = name === undefined ? factoryAt(sourceFile, offset) : undefined;
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
