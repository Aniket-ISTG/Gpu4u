import assert from "node:assert/strict";
import test from "node:test";
import { PrivateKey, TransferTransaction } from "@hiero-ledger/sdk";
import {
  MAX_VALID_DURATION_SECONDS,
  PaymentBuildError,
  TESTNET_NODE_ACCOUNTS,
  buildPaymentTransaction,
  bytesToBase64,
  createSignedPayment,
  selectTerms,
  type PaymentRequired,
  type PaymentRequirements,
} from "../lib/payments/payment-transaction.ts";
import { formatDuration, meterLeaseTime } from "../lib/payments/lease-meter.ts";

const PAYER = "0.0.6000001";
const MERCHANT = "0.0.7000002";
const FEE_PAYER = "0.0.7000003";
const AMOUNT = "616513762";

const terms = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact", network: "hedera:testnet", amount: AMOUNT, asset: "0.0.0", payTo: MERCHANT,
  maxTimeoutSeconds: 180, extra: { feePayer: FEE_PAYER }, ...over,
});
const required = (...accepts: PaymentRequirements[]): PaymentRequired => ({ x402Version: 2, resource: { url: "http://x/v1/leases" }, accepts });
const expected = { payTo: MERCHANT, tinybars: AMOUNT };

const decode = (tx: TransferTransaction) => TransferTransaction.fromBytes(tx.toBytes()) as TransferTransaction;
const transfersOf = (tx: TransferTransaction) =>
  new Map([...decode(tx).hbarTransfers].map(([account, hbar]) => [account.toString(), hbar.toTinybars().toString()]));

// ---- choosing the terms the wallet is asked to sign

test("selects the testnet exact option when it matches the quote", () => {
  assert.deepEqual(selectTerms(required(terms()), expected), terms());
});

test("refuses terms that differ from the quote, so the wallet never signs something the user did not see", () => {
  const refuse = (over: Partial<PaymentRequirements>, pattern: RegExp) =>
    assert.throws(() => selectTerms(required(terms(over)), expected), (e: unknown) => e instanceof PaymentBuildError && e.code === "TERMS_MISMATCH" && pattern.test(e.message));

  refuse({ amount: String(BigInt(AMOUNT) + BigInt(1)) }, /asks for/);
  refuse({ amount: String(BigInt(AMOUNT) - BigInt(1)) }, /asks for/);
  refuse({ payTo: "0.0.9999999" }, /pays 0\.0\.9999999/);
  refuse({ asset: "0.0.429274" }, /not native HBAR/);
  refuse({ extra: {} }, /no valid fee payer/);
  refuse({ extra: { feePayer: "not-an-account" } }, /no valid fee payer/);
});

test("refuses an offer with no testnet exact option", () => {
  for (const offers of [[], [terms({ network: "hedera:mainnet" })], [terms({ scheme: "upto" })]]) {
    assert.throws(() => selectTerms(required(...offers), expected), (e: unknown) => e instanceof PaymentBuildError && e.code === "NO_TERMS");
  }
});

test("never signs for mainnet, even if the server offers it first", () => {
  const picked = selectTerms(required(terms({ network: "hedera:mainnet" }), terms()), expected);
  assert.equal(picked.network, "hedera:testnet");
});

// ---- the transfer itself

test("builds the transfer the x402 exact scheme requires: payer to merchant, with the facilitator as fee payer", () => {
  const tx = buildPaymentTransaction({ terms: terms(), payerAccountId: PAYER, memo: "gpu4u:q_abc" });
  const transfers = transfersOf(tx);
  assert.equal(transfers.size, 2);
  assert.equal(transfers.get(PAYER), "-" + AMOUNT, "the payer pays exactly the amount");
  assert.equal(transfers.get(MERCHANT), AMOUNT, "the merchant receives exactly the amount");
  assert.equal(decode(tx).transactionId?.accountId?.toString(), FEE_PAYER, "the facilitator is the fee payer, not the user");
  assert.equal(decode(tx).transactionMemo, "gpu4u:q_abc");
});

test("pins the transfer to ONE node, so a wallet's single signature is valid for every copy", () => {
  // A wallet signs one transaction body. With the SDK's default of several nodes, one signature is invalid for
  // the other copies and the official facilitator rejects the payment as signature_invalid.
  for (let i = 0; i < 25; i++) {
    const tx = buildPaymentTransaction({ terms: terms(), payerAccountId: PAYER });
    const nodes = decode(tx).nodeAccountIds ?? [];
    assert.equal(nodes.length, 1);
    assert.ok((TESTNET_NODE_ACCOUNTS as readonly string[]).includes(nodes[0].toString()));
  }
  assert.equal(decode(buildPaymentTransaction({ terms: terms(), payerAccountId: PAYER, nodeAccountId: "0.0.5" })).nodeAccountIds?.[0].toString(), "0.0.5");
});

test("spreads payments across nodes, and lets a test choose one", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(buildPaymentTransaction({ terms: terms(), payerAccountId: PAYER }).nodeAccountIds![0].toString());
  assert.ok(seen.size > 3, "not always the same node");
  const first = buildPaymentTransaction({ terms: terms(), payerAccountId: PAYER, random: () => 0 });
  const last = buildPaymentTransaction({ terms: terms(), payerAccountId: PAYER, random: () => 0.9999 });
  assert.equal(first.nodeAccountIds![0].toString(), TESTNET_NODE_ACCOUNTS[0]);
  assert.equal(last.nodeAccountIds![0].toString(), TESTNET_NODE_ACCOUNTS[TESTNET_NODE_ACCOUNTS.length - 1]);
});

test("allows the longest validity window, so a slow wallet prompt does not expire the payment", () => {
  assert.equal(MAX_VALID_DURATION_SECONDS, 180);
  const tx = buildPaymentTransaction({ terms: terms(), payerAccountId: PAYER });
  assert.equal(tx.transactionValidDuration, 180);
  assert.ok(tx.isFrozen(), "frozen with no network client");
});

test("is a fresh transaction every time, so a signature cannot be reused", () => {
  const a = buildPaymentTransaction({ terms: terms(), payerAccountId: PAYER });
  const b = buildPaymentTransaction({ terms: terms(), payerAccountId: PAYER });
  assert.notEqual(a.transactionId?.toString(), b.transactionId?.toString());
});

test("rejects an invalid payer account or amount", () => {
  assert.throws(() => buildPaymentTransaction({ terms: terms(), payerAccountId: "alice" }), (e: unknown) => e instanceof PaymentBuildError && e.code === "BAD_ACCOUNT");
  assert.throws(() => buildPaymentTransaction({ terms: terms({ amount: "0" }), payerAccountId: PAYER }), /above zero/);
  assert.throws(() => buildPaymentTransaction({ terms: terms({ extra: {} }), payerAccountId: PAYER }), /no fee payer/);
});

// ---- asking the wallet to sign

test("builds the payment payload from what the wallet returns", async () => {
  const key = PrivateKey.generateECDSA();
  let asked: TransferTransaction | null = null;
  const result = await createSignedPayment({
    required: required(terms()), expected, payerAccountId: PAYER, memo: "gpu4u:q_abc",
    signTransaction: async (tx) => { asked = tx; return tx.sign(key); },
  });

  assert.equal(result.payload.x402Version, 2);
  assert.deepEqual(result.payload.accepted, terms());
  assert.deepEqual(result.payload.resource, { url: "http://x/v1/leases" });
  const signed = TransferTransaction.fromBytes(Buffer.from(result.payload.payload.transaction, "base64"));
  assert.equal(signed.transactionId?.toString(), result.transactionId);
  assert.equal(signed.nodeAccountIds?.[0].toString(), result.nodeAccountId);
  assert.equal(asked !== null, true);
  assert.equal(transfersOf(asked!).get(PAYER), "-" + AMOUNT, "the wallet was shown exactly the quoted transfer");
});

test("never asks the wallet to sign terms that do not match the quote", async () => {
  let asked = false;
  await assert.rejects(
    createSignedPayment({
      required: required(terms({ amount: String(BigInt(AMOUNT) + BigInt(1)) })), expected, payerAccountId: PAYER,
      signTransaction: async (tx) => { asked = true; return tx; },
    }),
    (e: unknown) => e instanceof PaymentBuildError && e.code === "TERMS_MISMATCH",
  );
  assert.equal(asked, false, "the wallet was not even prompted");
});

test("passes a wallet rejection through, and produces no payment", async () => {
  await assert.rejects(
    createSignedPayment({
      required: required(terms()), expected, payerAccountId: PAYER,
      signTransaction: async () => { throw new Error("User rejected the request"); },
    }),
    /User rejected/,
  );
});

test("refuses an empty answer from the wallet", async () => {
  await assert.rejects(
    createSignedPayment({
      required: required(terms()), expected, payerAccountId: PAYER,
      signTransaction: async () => ({ toBytes: () => new Uint8Array() }) as never,
    }),
    (e: unknown) => e instanceof PaymentBuildError && e.code === "BAD_SIGNATURE",
  );
});

test("encodes bytes as base64 in the browser, with no Node Buffer, including large inputs", () => {
  const small = new Uint8Array([0, 1, 2, 250, 255]);
  assert.equal(bytesToBase64(small), Buffer.from(small).toString("base64"));
  const large = new Uint8Array(100_000).map((_, i) => i % 256);
  assert.equal(bytesToBase64(large), Buffer.from(large).toString("base64"));
});

// ---- the live lease meter matches the service's billing

test("the on-screen meter bills the same way as the service: by the second, to the cap", () => {
  const base = { hourlyUsd: 0.22, capUsd: 0.42, startedAtMs: 1_000_000 };
  assert.equal(meterLeaseTime({ ...base, capUsd: 5, nowMs: base.startedAtMs + 3600 * 1000 }).usd, 0.22);
  assert.equal(meterLeaseTime({ ...base, nowMs: base.startedAtMs + 60 * 1000 }).usd, 0.003666);
  assert.equal(meterLeaseTime({ ...base, nowMs: base.startedAtMs }).elapsedSeconds, 1, "the first second always counts");
  assert.equal(meterLeaseTime({ ...base, nowMs: base.startedAtMs + 1001 }).elapsedSeconds, 2, "a partial second counts as a whole one");

  const long = meterLeaseTime({ ...base, nowMs: base.startedAtMs + 10 * 3600 * 1000 });
  assert.equal(long.stoppedAtCap, true);
  assert.equal(long.capSeconds, 6872);
  assert.equal(long.usd, 0.419955); // the same figure the payment service bills: see its metering tests
  assert.ok(long.capFraction <= 1);
});

test("formats durations", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(3725), "1:02:05");
  assert.equal(formatDuration(-5), "0:00");
});
