import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintLifecycleUid } from "@cotal-ai/core";
import { workspaceSecretStore } from "@cotal-ai/workspace";
import { prepareActorToken, retireActorToken } from "../src/placement/custody.js";

const root = mkdtempSync(join(tmpdir(), "placement-custody-"));
const store = workspaceSecretStore(root);
const identity = { store, space: "placement-custody", instanceId: mintLifecycleUid(), actor: "placement-alpha", lifecycleUid: mintLifecycleUid() };
const concurrent = await Promise.all(Array.from({ length: 8 }, () => prepareActorToken(identity)));
for (const result of concurrent) assert.deepEqual(result, concurrent[0]);
assert.match(concurrent[0]!.actorTokenHash, /^sha256:[a-f0-9]{64}$/);
assert.deepEqual(await prepareActorToken({ ...identity, store: workspaceSecretStore(root) }), concurrent[0]);
await retireActorToken(identity);
assert.notEqual((await prepareActorToken(identity)).actorToken, concurrent[0]!.actorToken);
console.log("placement custody smoke: lifecycle-scoped token, concurrent winner recovery, digest, and retirement passed");
