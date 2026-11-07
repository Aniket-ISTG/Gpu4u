#!/usr/bin/env node
"use strict";

/**
 * GPU4U autonomous agent. It finds the x402 endpoint, works out what GPU a task needs, compares the live
 * marketplace, gets a price, pays for the lease with x402 on Hedera, and checks the money moved, all with no
 * human approving. Its own key signs the payment, held by this process only: the server never holds a payer key.
 *
 *   npm run agent -- "Fine-tune a 7B model with LoRA on 2M tokens" --max-total 0.10
 *
 * Options
 *   --max-total <usd>     the agent's own budget for the job's estimated total (default 0.25)
 *   --cap <usd>           spending cap for the payment (default: the estimate plus a quarter)
 *   --difficulty <level>  easy, medium or hard: scales the job volume the estimate assumes (default: auto-detected)
 *   --lease-seconds <n>   how long to hold the lease before ending it (default 10)
 *   --dry-run             find, compare, quote and read the 402 price, but do not pay
 *
 * Environment (put it in payment-engine/.env.agent, which is not committed)
 *   AGENT_ACCOUNT_ID, AGENT_PRIVATE_KEY   a funded Hedera testnet account that is the agent's own
 *   SERVICE_URL (default http://127.0.0.1:4021), WEB_URL (default http://localhost:3000)
 *
 * The agent obeys the spending policy it discovers. A payment above the automatic limit needs a human, so the
 * agent stops and says so instead of paying. Every step is anchored on the Hedera Consensus Service by the
 * payment service, and the agent re-reads the payment from the public mirror node before it believes it.
 */

const path = require("node:path");
const { pathToFileURL } = require("node:url");
require("dotenv").config({ path: path.resolve(__dirname, "../.env.agent"), quiet: true });
const { Transaction } = require("@hiero-ledger/sdk");
const { proto } = require("@hiero-ledger/proto");
const { parsePrivateKey } = require("../service/keys");

const FRONTEND = path.resolve(__dirname, "../../frontend");
const load = (file) => import(pathToFileURL(path.join(FRONTEND, file)).href);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (label, value) => console.log(label.padEnd(12) + value);
const step = (n, title) => console.log(`\n[${n}] ${title}`);

class AgentStop extends Error {
    constructor(message, code = 1) {
        super(message);
        this.exitCode = code;
    }
}

function parseArgs(argv) {
    const args = { task: [], maxTotal: 0.25, cap: undefined, leaseSeconds: 10, dryRun: false, difficulty: undefined };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--dry-run") args.dryRun = true;
        else if (a === "--max-total") args.maxTotal = Number(argv[++i]);
        else if (a === "--cap") args.cap = Number(argv[++i]);
        else if (a === "--difficulty") args.difficulty = argv[++i];
        else if (a === "--lease-seconds") args.leaseSeconds = Number(argv[++i]);
        else args.task.push(a);
    }
    args.task = args.task.join(" ").trim();
    return args;
}

async function http(method, url, body) {
    const response = await fetch(url, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = { raw: text };
    }
    return { status: response.status, headers: response.headers, body: json };
}

async function call(method, url, body, okStatuses = [200, 201]) {
    const r = await http(method, url, body);
    if (!okStatuses.includes(r.status)) {
        const detail = r.body && (r.body.message || r.body.error) ? `${r.body.error || ""} ${r.body.message || ""}`.trim() : JSON.stringify(r.body);
        throw new AgentStop(`${method} ${url} answered ${r.status}: ${detail}`);
    }
    return r.body;
}

/** Signs the way a Hedera wallet's hedera_signTransaction does: one signature over the one transaction body. */
function signWithKey(key) {
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

/** Reads the transaction from the public mirror node and checks it, not trusting anything the service said. */
async function verifyOnLedger({ mirrorUrl, transactionId, payer, payTo, amount, assetId }) {
    const mirrorId = transactionId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
    let record = null;
    for (let attempt = 0; attempt < 15 && !record; attempt++) {
        const r = await http("GET", `${mirrorUrl}/api/v1/transactions/${mirrorId}`);
        if (r.status === 200 && r.body.transactions?.length) record = r.body.transactions.find((t) => (t.nonce ?? 0) === 0) || r.body.transactions[0];
        else await wait(2000);
    }
    if (!record) return { ok: false, problems: ["the transaction is not on the ledger"] };
    const net = new Map();
    const lines = assetId === "0.0.0" ? record.transfers : (record.token_transfers || []).filter((t) => t.token_id === assetId);
    for (const t of lines) net.set(t.account, (net.get(t.account) ?? 0n) + BigInt(t.amount));
    const problems = [];
    if (record.result !== "SUCCESS") problems.push(`result was ${record.result}`);
    if ((net.get(payTo) ?? 0n) !== BigInt(amount)) problems.push(`merchant received ${net.get(payTo) ?? 0n}, expected ${amount}`);
    if ((net.get(payer) ?? 0n) !== -BigInt(amount)) problems.push(`payer net ${net.get(payer) ?? 0n}, expected -${amount}`);
    const feePayer = record.transaction_id.split("-")[0];
    if (feePayer === payer) problems.push("the agent paid its own network fee, but the facilitator should");
    return { ok: problems.length === 0, problems, result: record.result, feePayer, fee: record.charged_tx_fee, consensus: record.consensus_timestamp };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.task || args.task.length < 10) throw new AgentStop('Give the agent a task of at least 10 characters, e.g. npm run agent -- "Run 1000 inference requests on a 7B model"');
    const SERVICE = (process.env.SERVICE_URL || "http://127.0.0.1:4021").replace(/\/$/, "");
    const WEB = (process.env.WEB_URL || "http://localhost:3000").replace(/\/$/, "");
    const agentId = process.env.AGENT_ACCOUNT_ID;
    const agentKeyText = process.env.AGENT_PRIVATE_KEY;
    if (!agentId || !agentKeyText) throw new AgentStop("Set AGENT_ACCOUNT_ID and AGENT_PRIVATE_KEY (see payment-engine/.env.agent). This is the agent's own funded testnet account.");
    const agentKey = parsePrivateKey(agentKeyText);

    console.log(`\nGPU4U agent ${agentId}\nTask: ${args.task}`);

    // ---- 1. discover
    step(1, "Discover the paid endpoint");
    const doc = await call("GET", `${SERVICE}/.well-known/x402`);
    const resource = doc.resources.find((r) => r.scheme === "exact" && r.network === "hedera:testnet");
    if (!resource) throw new AgentStop("The service offers no x402 exact endpoint on hedera:testnet");
    say("Endpoint", `${resource.method} ${resource.resource}`);
    say("Settles on", `${doc.network} in ${resource.asset.symbol} through ${doc.facilitator.mode} facilitator (fee payer ${doc.facilitator.feePayer})`);
    say("Pays to", resource.payTo);
    const sc = doc.spendingControls;
    say("Limits", `auto up to $${sc.autoApproveLimitUsd}, wallet $${sc.dailyLimitUsd}/day, hard ceiling $${sc.hardCeilingUsd}, only to ${sc.recipientAllowlist.join(",")}`);
    if (doc.simulated) console.log("NOTE        the service is in SIMULATED mode: nothing will reach Hedera");
    const config = await call("GET", `${SERVICE}/v1/config`);

    // ---- 2. understand the task
    step(2, "Work out what the task needs");
    const { analysis } = await call("POST", `${WEB}/api/workloads/analyze`, { request: args.task, ...(args.difficulty ? { difficulty: args.difficulty } : {}) });
    const { DEFAULTS, parseModelParamsB, resolveProfile } = await load("lib/estimation/workload-profile.ts");
    const { applyDifficulty } = await load("lib/estimation/difficulty.ts");
    const params = parseModelParamsB(analysis.model);
    const provided = params !== null ? { modelParamsB: params } : {};
    const touched = params !== null ? ["modelParamsB"] : [];
    const profile = resolveProfile(analysis.taskType ?? "inference", provided).profile;
    void DEFAULTS;
    const constraints = {
        minVramGb: analysis.minimumVramGb,
        gpuCount: analysis.gpuCount,
        maxHourlyBudgetUsd: analysis.maxHourlyBudgetUsd,
        maxTotalBudgetUsd: args.maxTotal,
        maxDurationHours: null,
        cudaRequired: analysis.cudaRequired,
        optimization: analysis.optimization,
    };
    say("Task", `${profile.taskType}${analysis.model ? ", " + analysis.model : ""}, ${analysis.difficulty}`);
    say("Needs", `${constraints.gpuCount} GPU, >= ${constraints.minVramGb ?? "any"} GB VRAM, optimizing for ${constraints.optimization}, agent budget $${args.maxTotal}`);

    // ---- 3. compare the live marketplace
    step(3, "Compare the live marketplace");
    const snapshot = await call("GET", `${WEB}/api/marketplace`);
    const { rankOffersByEstimatedCost } = await load("lib/routing/cost-ranking.ts");
    const scaled = applyDifficulty(profile, new Set(touched), analysis.difficulty);
    const { ranked, rejected } = rankOffersByEstimatedCost(snapshot.offers, scaled, constraints);
    say("Offers", `${snapshot.offers.length} live (${snapshot.servedFrom}, ${snapshot.upstreamMs} ms) -> ${ranked.length} eligible, ${rejected.length} rejected`);
    if (!ranked.length) throw new AgentStop("No offer fits the task and the agent's budget. Nothing was paid.");
    ranked.slice(0, 3).forEach((r, i) => say(i === 0 ? "Best" : "Next", `${r.offer.provider} ${r.offer.gpuModel} x${r.offer.gpuCount} ${r.offer.vramGb}GB · $${r.hourlyPriceUsd.toFixed(2)}/h · ~${r.estimatedDurationHours.toFixed(2)} h · est $${r.estimatedTotalCostUsd.toFixed(4)} · score ${r.routingScore.toFixed(0)}`));
    const best = ranked[0];
    if (constraints.optimization === "cost") {
        const cheapest = Math.min(...ranked.map((r) => r.estimatedTotalCostUsd));
        if (best.estimatedTotalCostUsd > cheapest + 1e-9) throw new AgentStop("Internal check failed: the chosen offer is not the cheapest eligible one");
        say("Check", `the chosen offer is the cheapest of ${ranked.length} eligible ($${cheapest.toFixed(4)})`);
    }

    // ---- 4. quote
    step(4, "Get a priced quote");
    const { quote } = await call("POST", `${WEB}/api/quotes`, {
        wallet: agentId, offerId: best.offer.id, profile, touched, difficulty: analysis.difficulty, constraints,
        ...(args.cap ? { capUsd: args.cap } : {}), expectedEstimateUsd: best.estimatedTotalCostUsd,
    });
    say("Quote", `${quote.id}: ${quote.amountDisplay} ${quote.assetSymbol} (cap $${quote.capUsd}, estimate $${quote.estimateUsd}) for ${quote.hours.toFixed(2)} h`);
    say("Policy", `would be ${quote.policyPreview.decision}: ${quote.policyPreview.reasons.join("; ") || "within limits"}`);

    // ---- 5. spending controls
    step(5, "Apply the spending policy");
    const started = await call("POST", `${WEB}/api/payments`, { quoteId: quote.id });
    const paymentId = started.payment.id;
    say("Payment", `${paymentId} -> ${started.payment.decision} -> ${started.payment.status}`);
    if (started.payment.decision === "refuse") throw new AgentStop(`The policy refuses this payment: ${started.payment.decisionReasons.join("; ")}. The agent will not pay.`, 3);
    if (started.payment.status === "PENDING_APPROVAL" || started.payment.decision === "approval") {
        throw new AgentStop(`This payment is above the automatic limit ($${sc.autoApproveLimitUsd}) and needs a human's approval (${started.approval?.id}). The agent will not pay without it.`, 2);
    }

    // ---- 6. the dynamic 402
    step(6, "Ask the endpoint for the price (HTTP 402)");
    const probe = await http("POST", resource.resource, { quoteId: quote.id, paymentId });
    if (probe.status !== 402) throw new AgentStop(`Expected HTTP 402 from the endpoint, got ${probe.status}`);
    const { decodePaymentRequiredHeader } = await import("@x402/core/http");
    const required402 = decodePaymentRequiredHeader(probe.headers.get("PAYMENT-REQUIRED"));
    const terms = required402.accepts[0];
    say("402", `${terms.amount} of ${terms.asset} to ${terms.payTo}, fee payer ${terms.extra.feePayer}, network ${terms.network}`);
    if (String(terms.amount) !== String(quote.tinybars) || terms.payTo !== resource.payTo) throw new AgentStop("The 402 terms do not match the quote. The agent will not sign.");
    say("Check", "the 402 price equals the quote and the recipient is the allow-listed merchant");

    if (args.dryRun) {
        console.log("\nDry run: stopping before payment. Nothing was paid.\n");
        return;
    }

    // ---- 7. pay with x402
    step(7, "Sign and pay (x402 exact scheme)");
    const reqs = await call("GET", `${WEB}/api/payments/${paymentId}/requirements`);
    const { createSignedPayment } = await load("lib/payments/payment-transaction.ts");
    const signed = await createSignedPayment({
        required: reqs.required, expected: reqs.expected, payerAccountId: agentId, memo: reqs.memo, signTransaction: signWithKey(agentKey),
    });
    say("Signed", `transfer ${agentId} -> ${reqs.expected.payTo}, node ${signed.nodeAccountId}, facilitator pays the fee`);
    await call("POST", `${WEB}/api/payments/${paymentId}/submit`, { paymentPayload: signed.payload });

    // ---- 8. settlement
    step(8, "Wait for settlement and verify it");
    let view;
    for (let i = 0; i < 60; i++) {
        view = await call("GET", `${WEB}/api/payments/${paymentId}`);
        if (["LEASE_ACTIVE", "FAILED", "REFUSED", "EXPIRED"].includes(view.payment.status)) break;
        await wait(1500);
    }
    say("Status", view.payment.status + (view.payment.error ? ` (${view.payment.error})` : ""));
    if (view.payment.status !== "LEASE_ACTIVE") throw new AgentStop("The payment did not complete.");
    say("Transaction", view.payment.transactionId);
    if (view.links.payment.hashscan) say("HashScan", view.links.payment.hashscan);
    const ledger = config.simulated
        ? { ok: view.payment.settlement.verified === true, problems: [], simulated: true }
        : await verifyOnLedger({ mirrorUrl: config.explorer.mirror, transactionId: view.payment.transactionId, payer: agentId, payTo: resource.payTo, amount: quote.tinybars, assetId: terms.asset });
    if (!ledger.ok) throw new AgentStop("Independent ledger check FAILED: " + ledger.problems.join("; "));
    say("Ledger", config.simulated ? "verified by the service (simulated ledger)" : `independently verified on the mirror node: ${ledger.result}, fee ${ledger.fee} tinybars paid by ${ledger.feePayer} (the facilitator), consensus ${ledger.consensus}`);

    // ---- 9. use and end the lease
    step(9, "Hold the lease, then end it");
    say("Lease", `active, held ${args.leaseSeconds}s`);
    await wait(args.leaseSeconds * 1000);
    const ended = await call("POST", `${WEB}/api/payments/${paymentId}/end`, {});
    say("Ended", `${ended.payment.status}; held ${ended.lease.run?.billedSeconds ?? "?"}s; the payment is final, nothing is refunded`);

    // ---- 10. audit
    step(10, "Check the audit trail");
    await wait(4000);
    const audit = await call("GET", `${WEB}/api/payments/${paymentId}`);
    const states = audit.events.reduce((m, e) => ((m[e.hcs.status] = (m[e.hcs.status] || 0) + 1), m), {});
    say("Events", `${audit.events.length} (${Object.entries(states).map(([k, v]) => `${v} ${k}`).join(", ")}), hash chain ${audit.chain.valid ? "intact" : "BROKEN"}`);
    if (audit.links.topic.hashscan) say("Topic", audit.links.topic.hashscan);
    if (!audit.chain.valid) throw new AgentStop("The audit chain is broken");

    console.log(`\nDone. The agent found the endpoint, chose the cheapest eligible GPU, paid with x402 and verified the payment, with no human approving.\n`);
}

main().catch((error) => {
    console.error("\nagent stopped: " + error.message + "\n");
    process.exit(error.exitCode || 1);
});
