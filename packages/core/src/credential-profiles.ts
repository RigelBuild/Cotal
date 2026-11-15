import type { Profile } from "./provision.js";

/** Runtime list of credential profile labels for claim classification. */
export const PROFILES = Object.freeze([
  "agent", "manager-caller", "observer", "admin", "supervisor", "provisioner", "deprovisioner",
  "reconciler", "retirement-requester", "lifecycle-executor", "endpoint-serve-executor", "operator", "purger",
  "backup", "restore", "delivery", "membership-rw", "probe", "channel-writer", "channel-purger",
  "teardown", "control-caller-privileged", "control-caller-admin", "deployer", "endpoint-serve",
  "goal-writer", "session-caller", "session-serving", "session-ledger", "run-driver", "run-mediator",
  "run-operator", "endpoint-evictor", "issuer", "run-admitter", "transfer-writer", "transfer-reader",
  "remote-manager", "environment-bootstrap", "environment-manager-supervisor",
  "environment-manager-executor", "environment-manager-goal-writer", "dm-reader", "issued-store-recreate",
  "registry-reader", "webhook-publisher", "auth-roster-reader",
] as const satisfies readonly Profile[]);
