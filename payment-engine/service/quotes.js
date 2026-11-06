"use strict";

const crypto = require("node:crypto");
const { z } = require("zod");
const { usdToTinybars, tinybarsToHbarString } = require("./rate");
const { assertWalletEligible } = require("./wallet-check");

const AccountId = z.string().regex(/^0\.0\.\d+$/, "Expected an account ID like 0.0.1234");
const Positive = z.number().finite().positive();

const QuoteRequestSchema = z
    .object({
        wallet: AccountId,
        offer: z
            .object({
                id: z.string().min(1).max(200),
                provider: z.string().min(1).max(100),
                gpuModel: z.string().min(1).max(100),
                gpuCount: z.number().int().positive(),
                vramGb: Positive,
                region: z.string().max(200).default("unknown"),
            })
            .strict(),
        hours: Positive.max(24 * 30),
        hourlyUsd: Positive,
        estimateUsd: Positive,
        capUsd: Positive,
    })
    .strict()
    .refine((q) => q.capUsd >= q.estimateUsd, { message: "capUsd must be at least estimateUsd", path: ["capUsd"] });

/** Hash that binds a quote to the exact terms an approval and a payment must match. */
function termsHash({ id, payTo, tinybars, wallet, expiresAt, network }) {
    return crypto
        .createHash("sha256")
        .update(JSON.stringify({ id, payTo, tinybars: String(tinybars), asset: "0.0.0", network, wallet, expiresAt }))
        .digest("hex");
}

/**
 * The mock provider listing for the offer that was selected. A marketplace provider has no Hedera account of
 * its own, so GPU4U records an entry whose receiving account comes from HEDERA_RECEIVER_ID in .env. The
 * user's wallet pays that account, and refunds are sent back from it.
 */
function providerEntryFor(quote) {
    return {
        id: `prov_${quote.id.slice(2, 14)}`,
        mock: true,
        provider: quote.offer.provider,
        offerId: quote.offer.id,
        gpuModel: quote.offer.gpuModel,
        gpuCount: quote.offer.gpuCount,
        region: quote.offer.region,
        hourlyUsd: quote.hourlyUsd,
        receiverAccountId: quote.payTo,
        receiverSource: "HEDERA_RECEIVER_ID in payment-engine/.env",
    };
}

class QuoteService {
    constructor({ store, rates, policy, merchantAccountId, network, ttlSeconds, walletChecker = null, now = Date.now }) {
        this.store = store;
        this.rates = rates;
        this.policy = policy;
        this.merchantAccountId = merchantAccountId;
        this.network = network;
        this.ttlMs = ttlSeconds * 1000;
        this.walletChecker = walletChecker;
        this.now = now;
    }

    async create(input) {
        const request = QuoteRequestSchema.parse(input);
        const rate = await this.rates.getRate();
        const tinybars = usdToTinybars(request.capUsd, rate);
        // In wallet mode the user pays. Refuse a wallet that could not complete or be refunded, up front.
        if (this.walletChecker) await assertWalletEligible(this.walletChecker, request.wallet, tinybars);

        const createdAt = this.now();
        const id = `q_${crypto.randomBytes(12).toString("hex")}`;
        const expiresAt = createdAt + this.ttlMs;
        const quote = this.store.insertQuote({
            id,
            createdAt,
            expiresAt,
            wallet: request.wallet,
            payTo: this.merchantAccountId,
            offer: request.offer,
            hours: request.hours,
            hourlyUsd: request.hourlyUsd,
            estimateUsd: request.estimateUsd,
            capUsd: request.capUsd,
            tinybars,
            rate,
            termsHash: termsHash({ id, payTo: this.merchantAccountId, tinybars, wallet: request.wallet, expiresAt, network: this.network }),
        });
        return this.present(quote);
    }

    get(id) {
        const quote = this.store.getQuote(id);
        return quote ? this.present(quote) : null;
    }

    /** Adds the HBAR display amount and a live policy preview. */
    present(quote) {
        const preview = this.policy.evaluate({ capUsd: quote.capUsd, payTo: quote.payTo, wallet: quote.wallet });
        return {
            ...quote,
            providerEntry: providerEntryFor(quote),
            hbar: tinybarsToHbarString(quote.tinybars),
            expired: this.now() >= quote.expiresAt,
            policyPreview: preview,
        };
    }
}

module.exports = { QuoteService, QuoteRequestSchema, termsHash, AccountId };
