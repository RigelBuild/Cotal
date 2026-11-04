import type { RuntimeReapEvidence } from "../../implementations/manager/src/runtime/index.js";
import type { HolderReapEvidence } from "./src/holder.js";

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

type HolderReapEvidenceMatchesManager = Assert<Equals<HolderReapEvidence, RuntimeReapEvidence>>;
