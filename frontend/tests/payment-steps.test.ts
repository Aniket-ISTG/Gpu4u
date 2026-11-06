import assert from "node:assert/strict";
import test from "node:test";
import { deriveSteps, formatCountdown, secondsLeft, type Step } from "../lib/payments/steps.ts";
import type { PaymentStatus, PaymentView } from "../lib/payments/types.ts";

function view(status: PaymentStatus, events: string[], over: { decision?: "auto" | "approval" | "refuse" | null; reasons?: string[] } = {}): PaymentView {
  return {
    payment: { id: "pay_x", status, decision: over.decision === undefined ? "auto" : over.decision, decisionReasons: over.reasons ?? [] },
    quote: { hbar: "6.165", capUsd: 0.42 },
    approval: null,
    lease: null,
    chain: { valid: true, brokenAtSeq: null },
    events: events.map((eventType, i) => ({ seq: i + 1, eventType })),
  } as unknown as PaymentView;
}

const states = (steps: Step[]) => Object.fromEntries(steps.map((s) => [s.key, s.state]));

const AUTO_DONE = [
  "PAYMENT_RECEIVED", "POLICY_EVALUATED", "AUTO_APPROVED", "AGENT_REQUESTING_LEASE", "AGENT_TERMS_ACCEPTED",
  "PAYMENT_SIGNED", "PAYMENT_SETTLED_BY_FACILITATOR", "SETTLEMENT_VERIFIED", "LEASE_CREATED",
];

test("an automatic payment shows approval as skipped and every other step done", () => {
  const s = states(deriveSteps(view("LEASE_ACTIVE", AUTO_DONE)));
  assert.deepEqual(s, { quote: "done", policy: "done", approval: "skipped", payment: "done", verification: "done", lease: "done" });
});

test("a payment in progress marks exactly the next unfinished step as active", () => {
  const s = states(deriveSteps(view("AWAITING_402", ["PAYMENT_RECEIVED", "POLICY_EVALUATED", "AUTO_APPROVED", "AGENT_REQUESTING_LEASE"])));
  assert.equal(s.payment, "active");
  assert.equal(s.verification, "pending");
  assert.equal(s.lease, "pending");
  assert.equal(Object.values(s).filter((v) => v === "active").length, 1);
});

test("a payment waiting for a person shows approval as the active step and nothing after it started", () => {
  const steps = deriveSteps(view("PENDING_APPROVAL", ["PAYMENT_RECEIVED", "POLICY_EVALUATED", "HUMAN_APPROVAL_REQUESTED"], { decision: "approval" }));
  const s = states(steps);
  assert.equal(s.approval, "active");
  assert.equal(s.payment, "pending");
  assert.match(steps.find((x) => x.key === "approval")!.detail, /Waiting for your approval/);
});

test("an approved payment shows approval done", () => {
  const s = states(deriveSteps(view("AWAITING_402", ["POLICY_EVALUATED", "HUMAN_APPROVAL_REQUESTED", "HUMAN_APPROVAL_GRANTED", "AGENT_REQUESTING_LEASE"], { decision: "approval" })));
  assert.equal(s.approval, "done");
  assert.equal(s.payment, "active");
});

test("a rejected payment fails at approval and does not pretend anything after happened", () => {
  const steps = deriveSteps(view("REJECTED", ["POLICY_EVALUATED", "HUMAN_APPROVAL_REQUESTED", "HUMAN_APPROVAL_REJECTED"], { decision: "approval" }));
  const s = states(steps);
  assert.equal(s.approval, "failed");
  assert.equal(s.payment, "pending");
  assert.ok(!Object.values(s).includes("active"), "a stopped payment has no step in progress");
  assert.match(steps.find((x) => x.key === "approval")!.detail, /Rejected/);
});

test("an expired approval fails at approval", () => {
  const s = states(deriveSteps(view("EXPIRED", ["POLICY_EVALUATED", "HUMAN_APPROVAL_REQUESTED", "HUMAN_APPROVAL_EXPIRED"], { decision: "approval" })));
  assert.equal(s.approval, "failed");
});

test("a refused payment fails at the policy step and shows the reason", () => {
  const steps = deriveSteps(view("REFUSED", ["POLICY_EVALUATED", "PAYMENT_REFUSED"], { decision: "refuse", reasons: ["$30.00 is above the hard ceiling of $25.00"] }));
  assert.equal(states(steps).policy, "failed");
  assert.match(steps.find((x) => x.key === "policy")!.detail, /hard ceiling/);
});

test("the failing step is the one that was running", () => {
  const stages: [string[], string][] = [
    [["POLICY_EVALUATED", "AUTO_APPROVED", "AGENT_REQUESTING_LEASE", "AGENT_TERMS_REJECTED"], "payment"],
    [["POLICY_EVALUATED", "AUTO_APPROVED", "AGENT_REQUESTING_LEASE", "AGENT_TERMS_ACCEPTED", "PAYMENT_SIGNED"], "payment"],
    [["POLICY_EVALUATED", "AUTO_APPROVED", "AGENT_REQUESTING_LEASE", "AGENT_TERMS_ACCEPTED", "PAYMENT_SIGNED", "PAYMENT_SETTLED_BY_FACILITATOR", "SETTLEMENT_VERIFICATION_FAILED"], "verification"],
    [[...AUTO_DONE.slice(0, 8)], "lease"],
  ];
  for (const [events, failedKey] of stages) {
    const s = states(deriveSteps(view("FAILED", events)));
    assert.equal(s[failedKey], "failed", failedKey);
    assert.equal(Object.values(s).filter((v) => v === "failed").length, 1, "only one step is marked failed");
  }
});

test("the agent's refusal of the terms is explained", () => {
  const steps = deriveSteps(view("FAILED", ["POLICY_EVALUATED", "AUTO_APPROVED", "AGENT_REQUESTING_LEASE", "AGENT_TERMS_REJECTED"]));
  assert.match(steps.find((x) => x.key === "payment")!.detail, /refused the payment terms/);
});

test("a reconciled payment still shows every step done", () => {
  const s = states(deriveSteps(view("RECONCILED", [...AUTO_DONE, "LEASE_COMPLETED", "PAYMENT_RECONCILED"])));
  assert.equal(Object.values(s).filter((v) => v === "failed" || v === "active" || v === "pending").length, 0);
});

test("the countdown never goes negative and formats as minutes and seconds", () => {
  assert.equal(secondsLeft(10_000, 4_500), 6);
  assert.equal(secondsLeft(10_000, 20_000), 0);
  assert.equal(formatCountdown(0), "0:00");
  assert.equal(formatCountdown(65), "1:05");
  assert.equal(formatCountdown(300), "5:00");
});

// ---- wallet mode: the user's wallet signs the payment

function walletView(status: PaymentStatus, events: string[], over: { decision?: "auto" | "approval" | "refuse" | null } = {}): PaymentView {
  const v = view(status, events, over);
  return { ...v, payerMode: "wallet" } as PaymentView;
}

const WALLET_DONE = [
  "PAYMENT_RECEIVED", "POLICY_EVALUATED", "AUTO_APPROVED", "WALLET_SIGNATURE_REQUESTED", "PAYMENT_SIGNED_BY_WALLET",
  "PAYMENT_SETTLED_BY_FACILITATOR", "SETTLEMENT_VERIFIED", "LEASE_CREATED",
];

test("wallet mode adds a step for the user's wallet signature", () => {
  const keys = deriveSteps(walletView("LEASE_ACTIVE", WALLET_DONE)).map((s) => s.key);
  assert.deepEqual(keys, ["quote", "policy", "approval", "signature", "payment", "verification", "lease"]);
  assert.ok(!deriveSteps(view("LEASE_ACTIVE", AUTO_DONE)).some((s) => s.key === "signature"), "agent mode has no signature step");
});

test("a completed wallet payment shows every step done, with approval skipped for a small payment", () => {
  const s = states(deriveSteps(walletView("LEASE_ACTIVE", WALLET_DONE)));
  assert.deepEqual(s, { quote: "done", policy: "done", approval: "skipped", signature: "done", payment: "done", verification: "done", lease: "done" });
});

test("while waiting for the wallet, the signature step is the one in progress and nothing after it started", () => {
  const steps = deriveSteps(walletView("AWAITING_SIGNATURE", ["PAYMENT_RECEIVED", "POLICY_EVALUATED", "AUTO_APPROVED", "WALLET_SIGNATURE_REQUESTED"]));
  const s = states(steps);
  assert.equal(s.signature, "active");
  assert.equal(s.payment, "pending");
  assert.match(steps.find((x) => x.key === "signature")!.detail, /Waiting for you to sign/);
});

test("a large wallet payment needs approval and then the signature, in that order", () => {
  const waiting = states(deriveSteps(walletView("PENDING_APPROVAL", ["POLICY_EVALUATED", "HUMAN_APPROVAL_REQUESTED"], { decision: "approval" })));
  assert.equal(waiting.approval, "active");
  assert.equal(waiting.signature, "pending");

  const approved = states(deriveSteps(walletView("AWAITING_SIGNATURE", ["POLICY_EVALUATED", "HUMAN_APPROVAL_REQUESTED", "HUMAN_APPROVAL_GRANTED", "WALLET_SIGNATURE_REQUESTED"], { decision: "approval" })));
  assert.equal(approved.approval, "done");
  assert.equal(approved.signature, "active");
});

test("a signature that never came fails at the signature step, not at approval", () => {
  const s = states(deriveSteps(walletView("EXPIRED", ["POLICY_EVALUATED", "AUTO_APPROVED", "WALLET_SIGNATURE_REQUESTED", "SIGNATURE_WINDOW_EXPIRED"])));
  assert.equal(s.signature, "failed");
  assert.notEqual(s.approval, "failed");
});

test("an approval that timed out still fails at approval in wallet mode", () => {
  const s = states(deriveSteps(walletView("EXPIRED", ["POLICY_EVALUATED", "HUMAN_APPROVAL_REQUESTED", "HUMAN_APPROVAL_EXPIRED"], { decision: "approval" })));
  assert.equal(s.approval, "failed");
});

test("a rejected approval stops before the wallet is asked", () => {
  const s = states(deriveSteps(walletView("REJECTED", ["POLICY_EVALUATED", "HUMAN_APPROVAL_REQUESTED", "HUMAN_APPROVAL_REJECTED"], { decision: "approval" })));
  assert.equal(s.approval, "failed");
  assert.equal(s.signature, "pending");
});

test("a payment the network or verification rejected fails at the right step", () => {
  const settled = states(deriveSteps(walletView("FAILED", WALLET_DONE.slice(0, 5))));
  assert.equal(settled.payment, "failed", "signed but never settled");
  const unverified = states(deriveSteps(walletView("FAILED", WALLET_DONE.slice(0, 6))));
  assert.equal(unverified.verification, "failed", "settled but not confirmed on the ledger");
  assert.equal(unverified.lease, "pending", "no lease without a confirmed payment");
});
