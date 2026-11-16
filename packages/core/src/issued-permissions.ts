import { closed } from "./issued-accepted.js";
import { subjectMatches } from "./subjects.js";

/** One direction's allow set. Explicit: the native NATS fragment's omitted or empty `allow` means
 *  UNRESTRICTED, and a ceiling that read that as "nothing" would be exactly the inversion a
 *  copied ledger row produces, so the mode is always spelled out. */
export type IssuedSubjectAllow =
  | { readonly mode: "all" }
  | { readonly mode: "none" }
  | { readonly mode: "patterns"; readonly patterns: readonly string[] };

export interface IssuedSubjectPermission {
  readonly allow: IssuedSubjectAllow;
  readonly deny: readonly string[];
}

/** The ceiling: what the credential may publish and subscribe, as the broker enforces it. */
export interface IssuedSubjectPermissions {
  readonly publish: IssuedSubjectPermission;
  readonly subscribe: IssuedSubjectPermission;
}

function subjectToken(value: unknown, pattern: boolean): string {
  if (typeof value !== "string" || value.length === 0 || /\s/u.test(value)
    || [...value].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127))
    throw new Error("a subject must be nonempty without whitespace or control characters; queue-qualified forms are not a ceiling entry");
  const parts = value.split(".");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || (part.includes("*") && (!pattern || part !== "*"))
      || (part.includes(">") && (!pattern || part !== ">" || i !== parts.length - 1)))
      throw new Error(`subject "${value}" has an invalid token or wildcard`);
  }
  return value;
}

function patterns(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("subject patterns must be an explicit array");
  return Object.freeze(value.map((entry) => subjectToken(entry, true)));
}

function permission(allow: IssuedSubjectAllow, deny: readonly string[]): IssuedSubjectPermission {
  return Object.freeze({ allow: Object.freeze(allow), deny });
}

/** Read a stored permission value back, refusing every shape but the explicit one. */
export function readIssuedSubjectPermission(value: unknown): IssuedSubjectPermission {
  const raw = closed(value, ["allow", "deny"], "subject permission");
  const allow = closed(raw.allow, ["mode", "patterns"], "subject allow");
  const deny = patterns(raw.deny);
  if (allow.mode === "all" || allow.mode === "none") {
    if (Object.hasOwn(allow, "patterns")) throw new Error("only patterns mode carries a patterns field");
    return permission({ mode: allow.mode }, deny);
  }
  if (allow.mode !== "patterns") throw new Error("unsupported subject allow mode");
  const listed = patterns(allow.patterns);
  if (listed.length === 0) throw new Error("patterns mode requires a nonempty list");
  return permission({ mode: "patterns", patterns: listed }, deny);
}

export function readIssuedSubjectPermissions(value: unknown): IssuedSubjectPermissions {
  const raw = closed(value, ["publish", "subscribe"], "issued permissions");
  return Object.freeze({ publish: readIssuedSubjectPermission(raw.publish), subscribe: readIssuedSubjectPermission(raw.subscribe) });
}

/** The native NATS fragment (`{pub, sub}` with `allow`/`deny` lists) as the JWT carries it: an
 *  omitted or empty allow is UNRESTRICTED subject to denies. This is the one importer, and it
 *  takes the fragment, never a whole JWT: `resp` and queue-qualified rows need semantics of their
 *  own and are refused rather than dropped. */
export function importNativeSubjectPermissions(value: unknown): IssuedSubjectPermissions {
  const raw = closed(value, ["pub", "sub"], "native permissions");
  const direction = (v: unknown): IssuedSubjectPermission => {
    if (v === undefined) return permission({ mode: "all" }, Object.freeze([]));
    const r = closed(v, ["allow", "deny"], "native subject permission");
    const allow = Object.hasOwn(r, "allow") ? patterns(r.allow) : Object.freeze([]);
    const deny = Object.hasOwn(r, "deny") ? patterns(r.deny) : Object.freeze([]);
    return permission(allow.length ? { mode: "patterns", patterns: allow } : { mode: "all" }, deny);
  };
  for (const key of ["pub", "sub"]) if (Object.hasOwn(raw, key) && raw[key] === undefined) throw new Error("an explicit native direction must not be undefined");
  return Object.freeze({ publish: direction(raw.pub), subscribe: direction(raw.sub) });
}

/** Does the ceiling permit ONE concrete subject? Deny wins; `none` permits nothing. */
export function issuedPermitsSubject(value: IssuedSubjectPermission, concrete: string): boolean {
  const parsed = readIssuedSubjectPermission(value);
  subjectToken(concrete, false);
  if (parsed.deny.some((pattern) => subjectMatches(pattern, concrete))) return false;
  if (parsed.allow.mode === "none") return false;
  return parsed.allow.mode === "all" || parsed.allow.patterns.some((pattern) => subjectMatches(pattern, concrete));
}

/** Does policy pattern `cap` cover EVERY subject `pattern` matches? Token-wise, both in the
 *  NATS grammar; a non-terminal `>` on either side fails closed. */
function patternCovers(cap: string, pattern: string): boolean {
  const c = cap.split(".");
  const p = pattern.split(".");
  if (c.slice(0, -1).includes(">") || p.slice(0, -1).includes(">")) return false;
  for (let i = 0; i < c.length; i++) {
    if (c[i] === ">") return p.length > i;
    if (i >= p.length) return false;
    if (c[i] === "*") { if (p[i] === ">") return false; continue; }
    if (c[i] !== p[i]) return false;
  }
  return c.length === p.length;
}

/** Could patterns `a` and `b` match one common subject? Conservative: a `>` on either side past
 *  the common prefix counts as overlap. */
function patternsOverlap(a: string, b: string): boolean {
  const x = a.split(".");
  const y = b.split(".");
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const s = x[i], t = y[i];
    if (s === ">" || t === ">") return true;
    if (s === undefined || t === undefined) return false;
    if (s === "*" || t === "*") continue;
    if (s !== t) return false;
  }
  return true;
}

/** Does the ceiling permit a SUBSCRIPTION whose filter is `pattern` (which may carry wildcards)?
 *  Every subject the filter could deliver must sit inside one allow entry, and no deny entry may
 *  overlap it: a subscription is a claim over a set of subjects, so a partial cover is a refusal,
 *  never a narrower grant invented on the caller's behalf. */
export function issuedPermitsPattern(value: IssuedSubjectPermission, pattern: string): boolean {
  const parsed = readIssuedSubjectPermission(value);
  subjectToken(pattern, true);
  if (parsed.deny.some((d) => patternsOverlap(d, pattern))) return false;
  if (parsed.allow.mode === "none") return false;
  return parsed.allow.mode === "all" || parsed.allow.patterns.some((a) => patternCovers(a, pattern));
}
