"use strict";

const crypto = require("node:crypto");
const sdk = require("@hiero-ledger/sdk");
const { createClientHederaSigner } = require("@x402/hedera");
const { Store } = require("./store");
const { RateService } = require("./rate");
const { PolicyEngine } = require("./policy");
const { QuoteService } = require("./quotes");
const { ApprovalService } = require("./approvals");
const { mirrorPublicKeyResolver } = require("./wallet-signature");
const { AuditLog } = require("./audit");
const { HcsPublisher } = require("./hcs");
const { SettlementVerifier, mirrorFetcher } = require("./verifier");
const { SimLedger } = require("./sim-ledger");
const { parsePrivateKey } = require("./keys");
const { PaymentAgent, NETWORK } = require("./agent");
const { SignedPaymentRelay } = require("./relay");
const { mirrorWalletChecker, ledgerWalletChecker } = require("./wallet-check");
const { auditSigner } = require("./config");
const { LeaseService } = require("./leases");
const { PaymentService } = require("./payments");
const {
    createSimulatedFacilitatorSigner,
    createTestnetFacilitatorSigner,
    createFacilitator,
} = require("./facilitator");

const SIM_IDS = { agent: "0.0.7000001", merchant: "0.0.7000002", feePayer: "0.0.7000003" };
const TINYBARS = 100_000_000n;
const HASHSCAN_TX = "https://hashscan.io/testnet/transaction";

/** Fee payers advertised by an external facilitator, cached for a few minutes. */
function externalFeePayers({ url, fetchImpl, ttlMs = 5 * 60_000, now = Date.now }) {
    let cached = null;
    return async () => {
        if (cached && now() - cached.at < ttlMs) return cached.value;
        const response = await fetchImpl(url + "/supported", { signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error("Facilitator /supported returned HTTP " + response.status);
        const body = await response.json();
        const value = (body.kinds || [])
            .filter((kind) => kind.network === NETWORK && kind.scheme === "exact" && kind.extra && kind.extra.feePayer)
            .map((kind) => kind.extra.feePayer);
        if (!value.length) throw new Error("Facilitator does not advertise " + NETWORK);
        cached = { value, at: now() };
        return value;
    };
}

/**
 * Builds every part of the service.
 *
 * simulated: creates its own accounts and a ledger in memory, so the whole flow runs with no credentials
 *            and nothing is sent to Hedera. For development and automated tests only.
 * testnet:   uses the configured accounts on the real Hedera testnet. The user's wallet is the payer.
 *            It never uses a simulated ledger, never uses a server-held payer, and never falls back to
 *            either: anything missing is an error.
 *
 * `overrides` lets tests replace the clock, exchange rate, ledger, fetch and key lookup. It is not
 * available in testnet mode for anything that would make settlement fake.
 */
async function buildServices(config, overrides = {}) {
    if (!config.simulated) {
        if (config.payer.mode !== "wallet") throw new Error("Testnet mode requires PAYER_MODE=wallet");
        if (overrides.ledger) throw new Error("A simulated ledger cannot be used in testnet mode");
        if (!config.hedera.merchantAccountId) throw new Error("Testnet mode requires the receiver account (HEDERA_RECEIVER_ID)");
        if (!auditSigner(config)) throw new Error("Testnet mode requires a funded key to post audit messages");
    }
    const walletPayer = config.payer.mode === "wallet";

    const now = overrides.now || Date.now;
    const fetchImpl = overrides.fetchImpl || fetch;
    const store = overrides.store || new Store(config.dbPath);
    const state = { baseUrl: null };

    const rates = overrides.rates || new RateService({
        mirrorUrl: config.hedera.mirrorUrl,
        fetchImpl,
        simulated: config.simulated,
        fallbackUsdPerHbar: config.simulation.fallbackUsdPerHbar,
        now,
    });

    let ledger = null;
    let agentKey = null;
    let agentAccountId = null;
    let merchantAccountId;
    let facilitator = null;
    let feePayerId = null;
    let verifier;
    let knownFeePayers;
    let publisher = null;
    let walletChecker = null;

    if (config.simulated) {
        ledger = overrides.ledger || new SimLedger({ now });
        const feeKey = sdk.PrivateKey.generateECDSA();
        merchantAccountId = config.hedera.merchantAccountId || SIM_IDS.merchant;
        feePayerId = config.facilitator.feePayerAccountId || SIM_IDS.feePayer;
        const start = BigInt(Math.round(config.simulation.startingBalanceHbar)) * TINYBARS;
        if (!walletPayer) {
            agentKey = sdk.PrivateKey.generateECDSA();
            agentAccountId = config.hedera.agentAccountId || SIM_IDS.agent;
            ledger.addAccount(agentAccountId, { key: agentKey.publicKey, balance: start });
        }
        ledger.addAccount(merchantAccountId, { balance: ledger.balanceOf(merchantAccountId) });
        ledger.addAccount(feePayerId, { key: feeKey.publicKey, balance: start });

        facilitator = createFacilitator(createSimulatedFacilitatorSigner({ ledger, feePayerId }));
        knownFeePayers = async () => [feePayerId];
        verifier = new SettlementVerifier({
            fetchTransaction: async (id) => ledger.getMirrorTransactions(id),
            retries: 3,
            retryDelayMs: 5,
        });
        if (walletPayer) walletChecker = ledgerWalletChecker({ ledger });
    } else {
        merchantAccountId = config.hedera.merchantAccountId;

        if (config.facilitator.mode === "local") {
            feePayerId = config.facilitator.feePayerAccountId;
            facilitator = createFacilitator(createTestnetFacilitatorSigner({
                feePayerId,
                feePayerPrivateKey: config.facilitator.feePayerPrivateKey,
                mirrorUrl: config.hedera.mirrorUrl,
            }));
            knownFeePayers = async () => [feePayerId];
        } else {
            knownFeePayers = externalFeePayers({ url: config.facilitator.url, fetchImpl, now });
        }

        verifier = new SettlementVerifier({
            fetchTransaction: mirrorFetcher(config.hedera.mirrorUrl, fetchImpl),
            explorerBase: HASHSCAN_TX,
            retries: 15,
            retryDelayMs: 2000,
        });
        // Audit messages are paid for by the fee payer (or the receiver, if its key was given). There is no
        // server-held payer in testnet mode, and receiving a payment needs no key at all.
        const signer = auditSigner(config);
        publisher = new HcsPublisher({
            store,
            accountId: signer.accountId,
            privateKey: signer.privateKey,
            topicId: config.hedera.hcsTopicId,
            mirrorUrl: config.hedera.mirrorUrl,
            fetchImpl,
        });
        walletChecker = mirrorWalletChecker({ mirrorUrl: config.hedera.mirrorUrl, fetchImpl });
    }

    const audit = new AuditLog({ store, publisher });
    const policy = new PolicyEngine({
        limits: config.policy,
        allowedPayTo: [merchantAccountId],
        store,
        now,
    });
    const quotes = new QuoteService({
        store, rates, policy, merchantAccountId,
        network: NETWORK, ttlSeconds: config.quoteTtlSeconds,
        walletChecker: walletPayer ? walletChecker : null,
        now,
    });
    const approvals = new ApprovalService({
        store,
        mode: config.approval.mode,
        ttlMs: config.approval.ttlSeconds * 1000,
        publicKeyResolver: overrides.publicKeyResolver || mirrorPublicKeyResolver(config.hedera.mirrorUrl, fetchImpl),
        now,
    });

    let agent = null;
    if (!walletPayer) {
        const signer = createClientHederaSigner(agentAccountId, agentKey, { network: NETWORK });
        agent = new PaymentAgent({
            signer,
            leaseUrl: () => state.baseUrl,
            knownFeePayers,
            fetchImpl: overrides.agentFetch || fetch,
        });
    }

    // Wallet mode: only this process can reach the lease endpoint, through the relay and its checks.
    const relaySecret = crypto.randomBytes(24).toString("hex");
    const relay = walletPayer
        ? new SignedPaymentRelay({ baseUrl: () => state.baseUrl, secret: relaySecret, fetchImpl: overrides.relayFetch || fetch })
        : null;

    const leases = new LeaseService({
        store, audit, verifier, merchantAccountId, now,
    });
    const topicId = () => (publisher && publisher.topicId) || config.hedera.hcsTopicId || null;
    const payments = new PaymentService({
        config, store, policy, approvals, audit, agent, relay, verifier, leases, knownFeePayers, topicId, now,
    });

    return {
        config, store, state, now, fetchImpl, rates, ledger, facilitator, knownFeePayers, relaySecret,
        quotes, policy, approvals, audit, agent, relay, verifier, leases, payments, publisher, walletChecker,
        accounts: { agent: agentAccountId, merchant: merchantAccountId, feePayer: feePayerId },
        async close() {
            await payments.idle();
            await audit.flush();
            publisher && publisher.close();
            store.close();
        },
    };
}

module.exports = { buildServices, SIM_IDS };
