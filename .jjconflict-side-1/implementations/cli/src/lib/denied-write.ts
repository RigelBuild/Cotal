import { CommandFailure, type Connection } from "@cotal-ai/workspace";
/** A broker write refusal names the operation, never a profile inferred from an unverified holder name. */
export function deniedWrite(connection: Connection, explicitCreds: boolean, write: string, kept: string, error: unknown, extra: Omit<NonNullable<ConstructorParameters<typeof CommandFailure>[3]>, "remedy"> = {}): CommandFailure {
  const native = (error as { cause?: { message?: unknown } } | null)?.cause?.message ?? (error as Error | null)?.message;
  return new CommandFailure("refused", "PERMISSION_DENIED", `this credential may not ${write} in ${connection.space}, so nothing was ${kept}${typeof native === "string" ? `: ${native}` : ""}`, {
    ...extra,
    remedy: explicitCreds
      ? `run it without --creds to use the operator credential this machine records for ${connection.space}, or use a credential that may ${write}`
      : `use a credential that may ${write} in ${connection.space}`,
  });
}
