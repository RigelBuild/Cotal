import type { ManagedLifecycleTarget } from "./managed-handoff.js";
import type { RemoteManagedAgentEnrollmentResult } from "./remote-manager-authority.js";

/** A registered manager claim, checked as authorization context rather than replay identity. */
export interface ManagerClaim {
  readonly accountPublicKey: string;
  readonly instanceId: string;
  readonly managerLifecycleUid: string;
  readonly assignmentRevision: number;
  readonly currentRegistrationRevision: number;
  readonly serveEpoch: number;
}

/** One desired seat incarnation selected by the reconciler. */
export interface Placement {
  readonly space: "main";
  readonly name: string;
  readonly desiredRevision: number;
  readonly seatRevision: number;
  readonly claim: ManagerClaim;
  readonly generation: number;
  readonly operationId: string;
  readonly workspace: string;
}

export interface ProfileSnapshot {
  readonly name: string;
  readonly revision: string;
  readonly configRevision: string;
  readonly modelRoles: Readonly<Record<string, string>>;
  readonly sha256: string;
}

export interface RuntimeAssets {
  readonly revision: string;
  readonly digest: string;
  readonly imageDigest: string;
  readonly baselineConfigDigest: string;
  readonly modelCatalogDigest: string;
  readonly personaCatalogDigest: string;
  readonly extensionsDigest: string;
  readonly rulesSkillsDigest: string;
  readonly cliClosureDigest: string;
  readonly toolBindings: readonly { readonly id: string; readonly endpoint: string; readonly entitlementRef: string }[];
}

export type AccountSelection = "shared" | readonly string[];
export interface KeyRequest {
  readonly routing: Partial<Record<"claude" | "codex", AccountSelection>>;
  readonly limits: {
    readonly keyCap?: number;
    readonly perModel?: Readonly<Record<string, { readonly tokens?: number; readonly tpm?: number; readonly rpm?: number }>>;
  };
}
export interface KeySettings extends KeyRequest { readonly policyId: string; }

export interface SeatEntryV2 {
  readonly name: string;
  readonly seatRevision: number;
  readonly cwd: string;
  readonly tab: string;
  readonly state: "active" | "paused" | "retired";
  readonly restartGeneration: number;
  readonly parent?: string;
  readonly note?: string;
  readonly updatedAt: string;
  readonly host?: "k3s" | "macbook" | "mattmini";
  readonly profile: string;
  readonly role: string;
  readonly roleTreeRevision: number;
  readonly key: KeySettings;
  readonly workspace: string;
  readonly persona: string;
  readonly expiresAt?: string;
}

export interface HandoffReceipt {
  readonly receiptId: string;
  readonly request: { readonly restartOperationId: string; readonly name: string; readonly predecessorGeneration: number; readonly restartGeneration: number };
  readonly lifecycle: ManagedLifecycleTarget;
  readonly artifactRef: { readonly kind: "wave-handoff/v1"; readonly id: string };
  readonly artifactDigest: string;
  readonly sizeBytes: number;
  readonly at: string;
}
export type HandoffInput =
  | { readonly mode: "document"; readonly receipt: HandoffReceipt }
  | { readonly mode: "none"; readonly reason: "skip" | "not-running" | "superseded" };

export interface LaunchIntent {
  readonly placement: Placement;
  readonly cwd: string;
  readonly workspaceDigest: string;
  readonly persona: string;
  readonly personaDigest: string;
  readonly cardRole?: string;
  readonly profile: ProfileSnapshot;
  readonly role: string;
  readonly roleTreeRevision: number;
  readonly assets: RuntimeAssets;
  readonly key: KeySettings;
  readonly policyRevision: number;
  readonly restartGeneration: number;
  readonly handoff?: HandoffInput;
  readonly digest: string;
}

export interface AgentKeyTarget {
  readonly seatName: string;
  readonly lifecycle: ManagedLifecycleTarget;
  readonly generation: number;
}

/** Nonsecret auth-owned enrollment identity. */
export interface EnrollmentIdentity {
  readonly acceptanceId: string;
  readonly enrollmentOperationId: string;
  readonly enrollmentRef: string;
  readonly target: AgentKeyTarget;
  readonly intentDigest: string;
}

export type ExecutionSubject =
  | { readonly acceptanceId: string; readonly enrollmentOperationId: string; readonly phase: "accepted" }
  | { readonly acceptanceId: string; readonly enrollmentOperationId: string; readonly phase: "bound"; readonly bindingId: string; readonly target: AgentKeyTarget };
export interface ExecutionAuthority {
  readonly subject: ExecutionSubject;
  readonly placementOperationId: string;
  readonly intentDigest: string;
  readonly claim: ManagerClaim;
  readonly launchRevision: number;
}
export interface ExecutionGate {
  readonly authority: ExecutionAuthority;
  readonly state: "open" | "closing" | "closed";
  readonly fenceId?: string;
}
export interface ExecutionEffect {
  readonly effectId: string;
  readonly authority: ExecutionAuthority;
  readonly operationId: string;
  readonly kind: "enroll" | "bind" | "create" | "bootstrap";
  readonly enrollment?: EnrollmentIdentity;
  readonly stageId?: string;
  readonly execution?: unknown;
  readonly state: "admitted" | "unknown" | "cancelled" | "effective";
}

export interface AcceptedIntent {
  readonly acceptanceId: string;
  readonly intent: LaunchIntent;
  readonly acceptedListRevision: number;
  readonly acceptedSeatRevision: number;
  readonly enrollmentOperationId: string;
  readonly executionGate: ExecutionGate;
}
export interface EnrollmentBinding {
  readonly bindingId: string;
  readonly identity: EnrollmentIdentity;
  readonly acceptedClaim: ManagerClaim;
  readonly boundClaim: ManagerClaim;
  readonly verifiedListRevision: number;
  readonly verifiedSeatRevision: number;
  readonly executionGate: ExecutionGate;
}

/** Exact auth.enroll-placement body. The participant sends only the token digest. */
export interface EnrollPlacementRequest {
  readonly acceptanceId: string;
  readonly enrollmentOperationId: string;
  readonly authority: ExecutionAuthority;
  readonly actorTokenHash: string;
}
export interface EnrollPlacementResult {
  readonly identity: EnrollmentIdentity;
  readonly material: RemoteManagedAgentEnrollmentResult["material"];
}
export interface VerifyPlacementEnrollmentRequest {
  readonly identity: EnrollmentIdentity;
  readonly claim: ManagerClaim;
}
export interface VerifyPlacementEnrollmentResult {
  readonly identity: EnrollmentIdentity;
  readonly active: true;
}
