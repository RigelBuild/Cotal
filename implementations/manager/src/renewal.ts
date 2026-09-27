/** Whether a managed-static credential has reached its off-tick renewal point. Renewing at 37.5%
 *  keeps the manager's TTL/4 pass ahead of the endpoint's 75% re-read. */
export function managedStaticCredOffTickRenewalDue(iat: number, exp: number, nowSec: number): boolean {
  return nowSec >= Math.ceil(iat + 0.375 * (exp - iat));
}
