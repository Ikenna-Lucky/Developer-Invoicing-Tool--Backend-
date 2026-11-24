import { db, closeDatabase } from "../src/db";
import { reconcilePayoutAccount } from "../src/lib/payouts";

try {
  const [id = "", code = ""] = process.argv.slice(2);
  await reconcilePayoutAccount(db, id, code);
  console.log("Payout account reconciled successfully");
} catch {
  console.error(
    "Payout reconciliation failed. Check the account, provider record, and environment before retrying.",
  );
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
