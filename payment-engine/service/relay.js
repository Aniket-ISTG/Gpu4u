"use strict";

const {
    decodePaymentRequiredHeader,
    decodePaymentResponseHeader,
    encodePaymentSignatureHeader,
} = require("@x402/core/http");

const RELAY_HEADER = "x-gpu4u-relay";

class RelayError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "RelayError";
        this.code = code;
    }
}

/**
 * Carries the wallet's signed payment to the x402 lease endpoint. The lease endpoint is the x402
 * merchant: it answers 402 with the exact terms, and given a signed payment it has the facilitator
 * verify and settle. In wallet mode the endpoint accepts only requests that carry this process's
 * private relay header, so a signed payment can reach it only through the checks in payments.js.
 */
class SignedPaymentRelay {
    constructor({ baseUrl, secret, fetchImpl = fetch }) {
        this.baseUrl = baseUrl;
        this.secret = secret;
        this.fetchImpl = fetchImpl;
    }

    headers(extra = {}) {
        return { "content-type": "application/json", [RELAY_HEADER]: this.secret, ...extra };
    }

    /** The server's x402 terms for this quote: an unpaid request, answered with 402. */
    async requirements({ quote, payment }) {
        const response = await this.fetchImpl(this.baseUrl() + "/v1/leases", {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify({ quoteId: quote.id, paymentId: payment.id }),
        });
        if (response.status !== 402) {
            const text = await response.text().catch(() => "");
            throw new RelayError("NO_TERMS", `Expected HTTP 402 payment terms, the lease API answered ${response.status} ${text.slice(0, 120)}`);
        }
        const header = response.headers.get("PAYMENT-REQUIRED");
        if (!header) throw new RelayError("NO_TERMS", "The lease API sent no payment terms");
        return decodePaymentRequiredHeader(header);
    }

    /** Sends the signed payment. Resolves with the facilitator's settlement result. */
    async submit({ quote, payment, paymentPayload }) {
        const response = await this.fetchImpl(this.baseUrl() + "/v1/leases", {
            method: "POST",
            headers: this.headers({ "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(paymentPayload) }),
            body: JSON.stringify({ quoteId: quote.id, paymentId: payment.id }),
        });

        if (response.status === 402) {
            // The facilitator refused the payment: verification or settlement failed.
            let reason = "The facilitator did not accept the payment";
            const header = response.headers.get("PAYMENT-REQUIRED");
            try {
                const required = header ? decodePaymentRequiredHeader(header) : await response.json();
                if (required && required.error) reason += ": " + required.error;
            } catch {
                /* keep the generic reason */
            }
            throw new RelayError("PAYMENT_REJECTED", reason);
        }
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new RelayError("LEASE_REQUEST_FAILED", `The lease API answered HTTP ${response.status}${text ? ": " + text.slice(0, 200) : ""}`);
        }

        const settlementHeader = response.headers.get("PAYMENT-RESPONSE") || response.headers.get("X-PAYMENT-RESPONSE");
        if (!settlementHeader) throw new RelayError("NO_SETTLEMENT", "The lease API returned no settlement receipt");
        const settlement = decodePaymentResponseHeader(settlementHeader);
        if (!settlement || !settlement.success || !settlement.transaction) {
            throw new RelayError("SETTLEMENT_FAILED", "Settlement failed: " + ((settlement && (settlement.errorReason || settlement.errorMessage)) || "unknown reason"));
        }
        return { transactionId: settlement.transaction, payer: settlement.payer || null, network: settlement.network, settlement };
    }
}

module.exports = { SignedPaymentRelay, RelayError, RELAY_HEADER };
