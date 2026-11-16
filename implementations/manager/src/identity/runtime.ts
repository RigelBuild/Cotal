import { EpEnvelopeError, rejectionText } from "@cotal-ai/core";
import { identityMint, identityRenew, identityReserve, identityRetire, identityRetireAdmin, type IdentityCommandServices, type IdentityMintResult } from "./commands.js";
import { IdentityRetirementDriver, type IdentityRetirementServices } from "./retirements.js";
import { IdentityStore } from "./store.js";

type RuntimeServices = Omit<IdentityCommandServices & IdentityRetirementServices, "identityStore" | "identityMintFlights" | "identityRenewFlights" | "identityRetirementClock" | "identityStoreForCommand" | "recheckIdentityRetirements"> & { readonly userMode: boolean };

export class IdentityRuntime {
  store?: IdentityStore;
  readonly mintFlights = new Map<string, Promise<IdentityMintResult>>();
  readonly renewFlights = new Map<string, Promise<IdentityMintResult>>();
  clock = () => Date.now();
  readonly driver = new IdentityRetirementDriver(() => this.services());

  constructor(private readonly dependencies: () => RuntimeServices) {}

  start(root: string, space: string, instanceId: string): void { this.store = new IdentityStore(root, space, instanceId); }
  stop(): void { this.driver.stop(); }
  tick(): void { void this.driver.recheckIdentityRetirements().catch((error) => console.error(`identity retirement sweep: ${rejectionText(error)}`)); }
  services(): IdentityCommandServices & IdentityRetirementServices {
    const deps = this.dependencies();
    return {
      ...deps,
      identityStore: this.store,
      identityMintFlights: this.mintFlights,
      identityRenewFlights: this.renewFlights,
      identityRetirementClock: this.clock,
      identityStoreForCommand: () => {
        if (!this.store || !deps.auth || deps.userMode)
          throw new EpEnvelopeError("unavailable", "identity commands require a local static-auth manager with an identity store", undefined, "not-executed");
        return this.store;
      },
      recheckIdentityRetirements: () => this.driver.recheckIdentityRetirements(),
    };
  }
  readonly reserve = (ctx: Parameters<typeof identityReserve>[1]) => identityReserve(this.services(), ctx);
  readonly mint = (ctx: Parameters<typeof identityMint>[1]) => identityMint(this.services(), ctx);
  readonly renew = (ctx: Parameters<typeof identityRenew>[1]) => identityRenew(this.services(), ctx);
  readonly retire = (ctx: Parameters<typeof identityRetire>[1]) => identityRetire(this.services(), ctx);
  readonly retireAdmin = (ctx: Parameters<typeof identityRetireAdmin>[1]) => identityRetireAdmin(this.services(), ctx);
}
