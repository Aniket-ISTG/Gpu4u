"use strict";

/**
 * Exercises the real Hedera testnet path end to end with your funded accounts, and prints a verification
 * link for every transaction:
 *
 *   quote -> payment signed -> settled by the local facilitator -> read back from the ledger -> lease
 *   -> lease ends (no refund) -> audit messages confirmed
 *
 *   npm run live:check
 *
 * IMPORTANT: this script signs the payment with a key you provide (HEDERA_TEST_PAYER_*) standing in for
 * the user's wallet. It proves settlement and audit anchoring on the real network. It is
 * NOT the application flow and it does NOT prove that HashPack can sign the payment. That needs a manual
 * test in a browser: see docs/testnet-manual-test.md.
 *
 * Needs, in .env: the merchant and facilitator fee-payer accounts and keys (see .env.example) and a funded
 * test payer account: HEDERA_TEST_PAYER_ID and HEDERA_TEST_PAYER_KEY.
 */

require("dotenv").config();
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { Transaction } = require("@hiero-ledger/sdk");
const { proto } = require("@hiero-ledger/proto");
const { loadConfig, assertRunnable } = require("../service/config");
const { buildServices } = require("../service/container");
const { createApp, startServer } = require("../service/app");
const { runPreflight } = require("../service/preflight");
const { parsePrivateKey } = require("../service/keys");

const BUILDER = path.resolve(__dirname, "../../frontend/lib/payments/payment-transaction.ts");
const LEASE_SECONDS = Number(process.env.LIVE_CHECK_LEASE_SECONDS || 12);

/** Signs the way a wallet's hedera_signTransaction does: one signature over the one transaction body. */
function signLikeAWallet(key) {
    return async (tx) => {
        const list = proto.TransactionList.decode(tx.toBytes());
        const merged = list.transactionList.map((entry) => {
            const signed = proto.SignedTransaction.decode(entry.signedTransactionBytes);
            const signature = key.sign(signed.bodyBytes);
            const field = key.type === "ED25519" ? { ed25519: signature } : { ECDSASecp256k1: signature };
            const pair = { pubKeyPrefix: key.publicKey.toBytesRaw(), ...field };
            return {
                signedTransactionBytes: proto.SignedTransaction.encode({
                    bodyBytes: signed.bodyBytes,
                    sigMap: proto.SignatureMap.create({ sigPair: [...(signed.sigMap?.sigPair || []), pair] }),
                }).finish(),
            };
        });
        return Transaction.fromBytes(proto.TransactionList.encode({ transactionList: merged }).finish());
    };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (label, value) => console.log(label.padEnd(18) + value);

async function main() {
    const payerId = process.env.HEDERA_TEST_PAYER_ID;
    const payerKeyText = process.env.HEDERA_TEST_PAYER_KEY;
    if (!payerId || !payerKeyText) {
        throw new Error("Set HEDERA_TEST_PAYER_ID and HEDERA_TEST_PAYER_KEY to a funded testnet account you control. It stands in for the user's wallet.");
    }

    const config = loadConfig({
        ...process.env,
        PAYMENT_MODE: "testnet", PAYER_MODE: "wallet", DB_PATH: ":memory:", APPROVAL_MODE: "click",
        SERVICE_TOKEN: process.env.SERVICE_TOKEN || "live-check-token-0123456789",
    });
    assertRunnable(config);

    console.log("\nLIVE TESTNET CHECK\nThe payer below is a key you provided, standing in for a wallet. This does not prove HashPack works.\n");
    const services = await buildServices(config);
    const report = await runPreflight({ config, services });
    report.forEach((line) => console.log(line));

    const { createSignedPayment } = await import(pathToFileURL(BUILDER).href);
    const app = createApp(services);
    const { server } = await startServer(app, services, 0);
    let failed = false;

    try {
        // A small job. At $3.60 an hour a $0.03 cap lasts 30 seconds,.
        const quote = await services.quotes.create({
            wallet: payerId,
            offer: { id: "live-check", provider: "live-check", gpuModel: "RTX 4090", gpuCount: 1, vramGb: 24, region: "n/a" },
            hours: 0.005, hourlyUsd: 3.6, estimateUsd: 0.018, capUsd: 0.03,
        });
        console.log("");
        say("Quote", `${quote.hbar} HBAR (cap $${quote.capUsd}) at $${quote.rate.usdPerHbar.toFixed(6)}/HBAR`);

        const started = services.payments.start({ quoteId: quote.id });
        say("Policy", `${started.payment.decision} -> ${started.payment.status}`);
        if (started.payment.status !== "AWAITING_SIGNATURE") throw new Error("Expected the payment to wait for a signature, got " + started.payment.status);

        const terms = await services.payments.getRequirements(started.payment.id);
        const signed = await createSignedPayment({
            required: terms.required, expected: terms.expected, payerAccountId: payerId, memo: terms.memo,
            signTransaction: signLikeAWallet(parsePrivateKey(payerKeyText)),
        });
        say("Signed", `transfer pinned to node ${signed.nodeAccountId}, fee payer ${terms.required.accepts[0].extra.feePayer}`);

        await services.payments.submitSigned(started.payment.id, { paymentPayload: signed.payload });
        await services.payments.idle();
        let view = services.payments.view(started.payment.id);
        say("Payment", view.payment.status + (view.payment.error ? "  " + view.payment.error : ""));
        if (view.payment.status !== "LEASE_ACTIVE") throw new Error("The payment did not complete: " + view.payment.error);
        say("Transaction", view.payment.transactionId);
        say("Verify (HashScan)", view.links.payment.hashscan);
        say("Verify (mirror)", view.links.payment.mirrorApi);

        say("Lease", `held for ${LEASE_SECONDS} seconds, billed by the second`);
        await wait(LEASE_SECONDS * 1000);
        view = await services.payments.endLease(started.payment.id);
        const rec = view.lease.reconciliation;
        say("Lease", `held ${view.lease.run.billedSeconds}s (lease time, not GPU utilization). The payment is final; nothing is refunded.`);
        if (view.payment.status !== "RECONCILED") failed = true;

        await services.audit.flush();
        await services.publisher.confirmPending();
        const events = services.audit.list(started.payment.id);
        const confirmed = events.filter((e) => e.hcs.status === "CONFIRMED").length;
        say("Audit", `${confirmed} of ${events.length} events confirmed on topic ${services.publisher.topicId}`);
        say("Topic", view.links.topic.hashscan);
        say("Chain", services.audit.verifyChain(started.payment.id).valid ? "intact" : "BROKEN");
        if (confirmed !== events.length) failed = true;

        console.log(failed ? "\nSome checks did not complete. See the lines above.\n" : "\nAll checks passed. Open the links above to confirm each transaction on Hedera testnet.\n");
    } finally {
        await new Promise((resolve) => server.server.close(resolve));
        await services.close();
    }
    if (failed) process.exitCode = 1;
}

main().catch((error) => {
    console.error("\nlive check failed: " + error.message);
    process.exit(1);
});
