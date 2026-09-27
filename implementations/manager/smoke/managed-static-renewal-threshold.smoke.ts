import { managedStaticCredRenewalDue } from "../src/renewal.js";

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean) => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`);
  }
};

const iat = 1_000;
const exp = 2_000;
check("not due before half-life", !managedStaticCredRenewalDue(iat, exp, 1_499));
check("due at half-life", managedStaticCredRenewalDue(iat, exp, 1_500));
check("due at 60% of life", managedStaticCredRenewalDue(iat, exp, 1_600));
check("due at 75% of life", managedStaticCredRenewalDue(iat, exp, 1_750));
check("not due for unexpired creds after issue time", !managedStaticCredRenewalDue(iat, exp, iat));

console.log(`\n== managed-static renewal threshold: ${pass} pass, ${fail} fail ==`);
if (fail > 0) process.exit(1);
