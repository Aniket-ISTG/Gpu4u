import type { PaymentView } from "./types.ts";

export type StepState = "done" | "active" | "pending" | "skipped" | "failed";

export interface Step {
  key: "quote" | "policy" | "approval" | "signature" | "payment" | "verification" | "lease";
  label: string;
  state: StepState;
  detail: string;
}

const FAILED_STATES = new Set(["REFUSED", "REJECTED", "EXPIRED", "FAILED"]);

/**
 * Turns a payment's recorded events into the steps a person follows: quote, policy, approval,
 * the agent's x402 payment, independent verification, lease. It reads only what was recorded, so
 * the page shows what actually happened and never what it expects to happen.
 */
export function deriveSteps(view: PaymentView): Step[] {
  const { payment, quote } = view;
  const seen = new Set(view.events.map((event) => event.eventType));
  const failed = FAILED_STATES.has(payment.status);
  const needsApproval = payment.decision === "approval";
  const refused = payment.status === "REFUSED";
  // In wallet mode the user's wallet signs the payment. In agent mode (simulated development) a server key pays.
  const walletMode = view.payerMode === "wallet";

  // The step that was running when the payment stopped is the one that failed.
  let failedKey: Step["key"] | null = null;
  if (failed) {
    if (refused) failedKey = "policy";
    else if (payment.status === "REJECTED") failedKey = "approval";
    else if (payment.status === "EXPIRED") {
      // An approval that timed out, or a signature the wallet never gave.
      failedKey = walletMode && seen.has("WALLET_SIGNATURE_REQUESTED") && !seen.has("HUMAN_APPROVAL_EXPIRED") ? "signature" : "approval";
    } else if (walletMode && !seen.has("PAYMENT_SIGNED_BY_WALLET")) failedKey = "signature";
    else if (seen.has("SETTLEMENT_VERIFIED")) failedKey = "lease";
    else if (seen.has("PAYMENT_SETTLED_BY_FACILITATOR")) failedKey = "verification";
    else failedKey = "payment";
  }

  const steps: Step[] = [];
  const push = (key: Step["key"], label: string, done: boolean, detail: string, skipped = false) => {
    let state: StepState;
    if (skipped) state = "skipped";
    else if (failedKey === key) state = "failed";
    else if (done) state = "done";
    else state = "pending";
    steps.push({ key, label, state, detail });
  };

  push("quote", "Quote locked", true, `${quote.amountDisplay} ${quote.assetSymbol} for up to $${quote.capUsd.toFixed(2)}`);

  push(
    "policy",
    "Spending policy",
    seen.has("POLICY_EVALUATED"),
    refused
      ? payment.decisionReasons.join(" ") || "Refused by policy"
      : payment.decision === "approval"
        ? "Above the automatic limit, so a person must approve"
        : payment.decision === "auto"
          ? "Within the automatic limit"
          : "Checking",
  );

  const approvalDetail = seen.has("HUMAN_APPROVAL_GRANTED")
    ? "Approved by the wallet owner"
    : seen.has("HUMAN_APPROVAL_REJECTED")
      ? "Rejected by the wallet owner"
      : seen.has("HUMAN_APPROVAL_EXPIRED")
        ? "Nobody answered in time"
        : needsApproval
          ? "Waiting for your approval"
          : "Not needed";
  push("approval", "Human approval", seen.has("HUMAN_APPROVAL_GRANTED") || (!needsApproval && seen.has("AUTO_APPROVED")), approvalDetail, !needsApproval && !failed && payment.decision !== null);

  if (walletMode) {
    push(
      "signature",
      "Your wallet signs",
      seen.has("PAYMENT_SIGNED_BY_WALLET"),
      seen.has("PAYMENT_SIGNED_BY_WALLET")
        ? "You signed this exact payment in your wallet"
        : seen.has("WALLET_SIGNATURE_REQUESTED")
          ? "Waiting for you to sign in your wallet"
          : "Not asked yet",
    );
    push(
      "payment",
      "Settles on Hedera with x402",
      seen.has("PAYMENT_SETTLED_BY_FACILITATOR"),
      seen.has("PAYMENT_SETTLED_BY_FACILITATOR")
        ? "The facilitator verified it and paid the network fee"
        : seen.has("PAYMENT_SIGNED_BY_WALLET")
          ? "Submitted, waiting for the network"
          : "Not started",
    );
  } else {
    push(
      "payment",
      "Agent pays with x402",
      seen.has("PAYMENT_SETTLED_BY_FACILITATOR"),
      seen.has("PAYMENT_SETTLED_BY_FACILITATOR")
        ? "Terms checked, signed, settled by the facilitator"
        : seen.has("AGENT_TERMS_REJECTED")
          ? "The agent refused the payment terms"
          : seen.has("PAYMENT_SIGNED")
            ? "Signed, waiting for settlement"
            : seen.has("AGENT_REQUESTING_LEASE")
              ? "Requesting the lease and checking the price"
              : "Not started",
    );
  }

  push(
    "verification",
    "Settlement verified",
    seen.has("SETTLEMENT_VERIFIED"),
    seen.has("SETTLEMENT_VERIFIED") ? "Read back from the ledger and matched exactly" : "Not checked yet",
  );

  push(
    "lease",
    "Lease active",
    seen.has("LEASE_CREATED"),
    seen.has("LEASE_CREATED") ? (walletMode ? "Created after the payment was confirmed. The lease clock is running" : "Simulated lease created") : "Not started",
  );

  // Mark the first unfinished step as the one in progress.
  if (!failed) {
    const next = steps.find((step) => step.state === "pending");
    if (next) next.state = "active";
  }
  return steps;
}

/** Seconds left until a time, never negative. */
export function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

export function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
