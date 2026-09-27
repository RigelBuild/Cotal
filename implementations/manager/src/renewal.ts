/** Whether a managed-static credential has reached its half-lifetime renewal point. Renewing at
 *  half-life, not 75%, means a TTL/4 pass always re-signs before the endpoint's 75% re-read. */
export function managedStaticCredRenewalDue(iat: number, exp: number, nowSec: number): boolean {
  return nowSec >= Math.ceil(iat + 0.5 * (exp - iat));
}
