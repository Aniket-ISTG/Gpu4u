"use strict";

const { x402Client } = require("@x402/core/client");
const { decodePaymentResponseHeader } = require("@x402/core/http");
const { wrapFetchWithPayment } = require("@x402/fetch");
const { ExactHederaScheme } = require("@x402/hedera/exact/client");
const { HBAR_ASSET_ID } = require("@x402/hedera");

const NETWORK = "hedera:testnet";
const MAX_TIMEOUT_SECONDS = 600;

class AgentError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = "AgentError";
        this.code = code;
        this.details = details;
    }
}

/**
 * Compares the server's payment terms with the quote the user approved.
 * The x402 client will sign whatever the server asks for, so this is the check that
 * stops a server from raising the price or changing the recipient after approval.
 * Returns a list of problems. An empty list means the terms are safe to sign.
 */
function checkTerms({ requirements, quote, knownFeePayers }) {
    const problems = [];
    if (requirements.scheme !== "exact") problems.push("Scheme is " + requirements.scheme + ", expected exact");
    if (requirements.network !== NETWORK) problems.push("Network is " + requirements.network + ", expected " + NETWORK);
    if (requirements.asset !== HBAR_ASSET_ID) problems.push("Asset is " + requirements.asset + ", expected native HBAR");
    if (requirements.payTo !== quote.payTo) problems.push("Pay-to is " + requirements.payTo + ", the approved quote names " + quote.payTo);
    if (String(requirements.amount) !== String(quote.tinybars)) {
        problems.push("Amount is " + requirements.amount + " tinybars, the approved quote is exactly " + quote.tinybars);
    }
    const feePayer = requirements.extra && requirements.extra.feePayer;
    if (!feePayer || !knownFeePayers.includes(feePayer)) {
        problems.push("Fee payer " + feePayer + " is not a facilitator account this agent trusts");
    }
    if (requirements.maxTimeoutSeconds && requirements.maxTimeoutSeconds > MAX_TIMEOUT_SECONDS) {
        problems.push("Timeout of " + requirements.maxTimeoutSeconds + " seconds is longer than the allowed " + MAX_TIMEOUT_SECONDS);
    }
    return problems;
}

/**
 * The paying agent. It calls the lease endpoint, receives HTTP 402 with payment terms, checks the
 * terms against the approved quote, signs a transfer from the agent account, and retries with the
 * signed payment. The facilitator then pays the network fee and submits it to Hedera.
 */
class PaymentAgent {
    /**
     * @param {object} opts
     * @param {import("@x402/hedera").ClientHederaSigner} opts.signer  The agent account's signer
     * @param {() => string} opts.leaseUrl  Base URL of the lease API, read when paying
     * @param {() => Promise<string[]>} opts.knownFeePayers  Fee payers the agent trusts, from the facilitator it is configured with
     */
    constructor({ signer, leaseUrl, knownFeePayers, fetchImpl = fetch, onEvent = () => {} }) {
        this.signer = signer;
        this.leaseUrl = leaseUrl;
        this.knownFeePayers = knownFeePayers;
        this.fetchImpl = fetchImpl;
        this.onEvent = onEvent;
    }

    get accountId() {
        return this.signer.accountId;
    }

    /**
     * Pays for a quote. A new client is built per payment so its checks are bound to this
     * quote only, and its own spend control allows exactly the quoted amount and nothing more.
     */
    async pay({ payment, quote, onSigned = async () => {}, onEvent = null }) {
        const emit = onEvent || this.onEvent;
        const feePayers = await this.knownFeePayers();
        const violations = [];

        const client = x402Client.fromConfig({
            schemes: [{ network: "hedera:*", client: new ExactHederaScheme(this.signer) }],
            spendControls: {
                maxAmountPerPayment: false,
                allowedAssets: [{ network: NETWORK, asset: HBAR_ASSET_ID, maxAmountPerPayment: String(quote.tinybars) }],
            },
        });

        client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
            const problems = checkTerms({ requirements: selectedRequirements, quote, knownFeePayers: feePayers });
            if (problems.length) {
                violations.push(...problems);
                emit({ type: "TERMS_REJECTED", problems });
                return { abort: true, reason: problems.join("; ") };
            }
            emit({
                type: "TERMS_ACCEPTED",
                amount: String(selectedRequirements.amount),
                payTo: selectedRequirements.payTo,
                feePayer: selectedRequirements.extra.feePayer,
            });
        });
        client.onAfterPaymentCreation(async () => {
            emit({ type: "PAYMENT_SIGNED", payer: this.accountId });
            await onSigned();
        });

        const payingFetch = wrapFetchWithPayment(this.fetchImpl, client);
        let response;
        try {
            response = await payingFetch(this.leaseUrl() + "/v1/leases", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ quoteId: quote.id, paymentId: payment.id }),
            });
        } catch (error) {
            if (violations.length) throw new AgentError("TERMS_REJECTED", "The payment terms were rejected: " + violations.join("; "), { violations });
            throw new AgentError("PAYMENT_FAILED", error.message);
        }

        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new AgentError("LEASE_REQUEST_FAILED", "Lease API answered HTTP " + response.status + (text ? ": " + text.slice(0, 200) : ""));
        }

        const header = response.headers.get("PAYMENT-RESPONSE") || response.headers.get("X-PAYMENT-RESPONSE");
        if (!header) throw new AgentError("NO_SETTLEMENT", "The lease API did not return a settlement receipt");
        const settlement = decodePaymentResponseHeader(header);
        if (!settlement || !settlement.success || !settlement.transaction) {
            throw new AgentError("SETTLEMENT_FAILED", "Settlement failed: " + (settlement && (settlement.errorReason || settlement.errorMessage) || "unknown reason"));
        }
        return {
            transactionId: settlement.transaction,
            payer: settlement.payer || null,
            network: settlement.network,
            settlement,
            body: await response.json().catch(() => ({})),
        };
    }
}

module.exports = { PaymentAgent, AgentError, checkTerms, NETWORK };
