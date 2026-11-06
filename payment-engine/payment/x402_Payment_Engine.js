"use strict";

/**
 * x402 Payment Protocol Engine for Hedera
 * Implements the official x402 v2 HTTP Payment Required specification on Hedera Testnet.
 */

const {
    HBAR_ASSET_ID,
    HEDERA_TESTNET_CAIP2,
    inspectHederaTransaction,
    createHederaPreflightTransfer,
    extractTransactionFromPayload
} = require("@x402/hedera");

const {
    Client,
    PrivateKey,
    TransferTransaction,
    Hbar,
    AccountId,
    TransactionId
} = require("@hiero-ledger/sdk");

const X402_VERSION = 2;

/**
 * Generates official x402 v2 Payment Requirements for GPU lease resources.
 */
function createPaymentRequirements({
    receiverAccountId,
    amountHbar,
    feePayer = null,
    maxTimeoutSeconds = 180,
    resourceUrl = "https://router.gpu/lease",
    description = "GPU Compute Lease Execution"
}) {
    if (!receiverAccountId || !/^0\.0\.\d+$/.test(receiverAccountId)) {
        throw new Error(`Invalid receiver account ID: '${receiverAccountId}'`);
    }
    if (typeof amountHbar !== "number" || amountHbar <= 0) {
        throw new Error(`Invalid amount: '${amountHbar}'. Must be positive number.`);
    }

    const tinybars = (BigInt(Math.round(amountHbar * 100_000_000))).toString();

    return {
        scheme: "exact",
        network: HEDERA_TESTNET_CAIP2,
        amount: tinybars,
        asset: HBAR_ASSET_ID,
        payTo: receiverAccountId,
        maxTimeoutSeconds,
        extra: {
            feePayer: feePayer || receiverAccountId
        },
        resource: {
            url: resourceUrl,
            description,
            mimeType: "application/json"
        }
    };
}

/**
 * Wraps signed transaction bytes into a standard x402 v2 PaymentPayload.
 */
function createPaymentPayload({
    requirements,
    transactionBase64,
    resourceUrl = null,
    description = null
}) {
    if (!requirements || !transactionBase64) {
        throw new Error("Requirements and transactionBase64 are required to build x402 PaymentPayload");
    }

    return {
        x402Version: X402_VERSION,
        resource: {
            url: resourceUrl || requirements.resource?.url || "https://router.gpu/lease",
            description: description || requirements.resource?.description || "GPU Compute Lease Execution",
            mimeType: "application/json"
        },
        accepted: {
            scheme: requirements.scheme,
            network: requirements.network,
            amount: requirements.amount,
            asset: requirements.asset,
            payTo: requirements.payTo,
            maxTimeoutSeconds: requirements.maxTimeoutSeconds,
            extra: requirements.extra
        },
        payload: {
            transaction: transactionBase64
        }
    };
}

/**
 * Verifies an incoming x402 PaymentPayload against on-chain state and scheme requirements.
 */
async function verifyPaymentPayload(paymentPayload, { preflight = null } = {}) {
    if (!paymentPayload || paymentPayload.x402Version !== X402_VERSION) {
        return {
            valid: false,
            error: `Unsupported x402 version: ${paymentPayload?.x402Version}. Expected version ${X402_VERSION}.`
        };
    }

    const { accepted, payload } = paymentPayload;
    if (!accepted || !payload?.transaction) {
        return {
            valid: false,
            error: "PaymentPayload is missing accepted requirements or payload.transaction."
        };
    }

    // 1. Inspect transaction bytes
    let inspected;
    try {
        inspected = inspectHederaTransaction(payload.transaction);
    } catch (err) {
        return {
            valid: false,
            error: `Failed to inspect Hedera transaction in payload: ${err.message}`
        };
    }

    // 2. Validate transaction structure
    if (inspected.transactionType !== "TransferTransaction") {
        return {
            valid: false,
            error: `Invalid transaction type '${inspected.transactionType}'. Expected 'TransferTransaction'.`
        };
    }

    if (inspected.hasNonTransferOperations) {
        return {
            valid: false,
            error: "Transaction contains illegal non-transfer operations."
        };
    }

    // 3. Verify transfers match accepted requirement
    const payTo = accepted.payTo;
    const requiredTinybars = BigInt(accepted.amount);

    const creditEntry = inspected.hbarTransfers.find(t => t.accountId === payTo && BigInt(t.amount) > 0n);
    if (!creditEntry) {
        return {
            valid: false,
            error: `Transaction does not credit payTo account '${payTo}'.`
        };
    }

    if (BigInt(creditEntry.amount) < requiredTinybars) {
        return {
            valid: false,
            error: `Credited amount (${creditEntry.amount} tinybars) is less than required (${requiredTinybars} tinybars).`
        };
    }

    const debitEntry = inspected.hbarTransfers.find(t => BigInt(t.amount) < 0n);
    if (!debitEntry) {
        return {
            valid: false,
            error: "Transaction does not specify a debiting payer account."
        };
    }

    // 4. Preflight account and balance verification via official @x402/hedera helper
    // Fail closed: if the balance check cannot run, the payment is not safe to send.
    let preflightResult;
    try {
        const runPreflight = preflight || createHederaPreflightTransfer();
        preflightResult = await runPreflight({
            payer: debitEntry.accountId,
            payTo: accepted.payTo,
            asset: accepted.asset || HBAR_ASSET_ID,
            amount: accepted.amount,
            network: accepted.network
        });
    } catch (err) {
        return {
            valid: false,
            error: `Preflight transfer verification could not be completed: ${err.message}`
        };
    }
    if (!preflightResult.ok) {
        return {
            valid: false,
            error: `Preflight transfer verification failed: ${preflightResult.message || preflightResult.reason}`
        };
    }

    return {
        valid: true,
        inspected,
        payerAccountId: debitEntry.accountId,
        payToAccountId: payTo,
        amountTinybars: creditEntry.amount,
        transactionId: inspected.transactionId
    };
}

/**
 * Executes settlement of an x402 PaymentPayload on Hedera Testnet.
 * If external facilitator URL is configured, routes via HTTP POST /settle;
 * otherwise executes via direct facilitator client or operator signer.
 */
async function settleX402Payment({
    paymentPayload,
    facilitatorUrl = null,
    facilitatorPrivateKey = null,
    facilitatorAccountId = null,
    preflight = null
}) {
    // 1. First verify payload
    const verification = await verifyPaymentPayload(paymentPayload, { preflight });
    if (!verification.valid) {
        throw new Error(`Cannot settle invalid x402 payment: ${verification.error}`);
    }

    // If external facilitator URL is provided, call external /settle
    if (facilitatorUrl) {
        console.log(`[x402_ENGINE] Forwarding to external x402 Facilitator: ${facilitatorUrl}/settle`);
        const res = await fetch(`${facilitatorUrl}/settle`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(paymentPayload)
        });

        if (!res.ok) {
            const errBody = await res.text();
            throw new Error(`External facilitator returned HTTP ${res.status}: ${errBody}`);
        }

        const settleResult = await res.json();
        return {
            settled: true,
            facilitatorType: "EXTERNAL",
            transactionId: settleResult.transactionId || verification.transactionId,
            details: settleResult
        };
    }

    // Local Facilitator Settlement (signs fee payer and submits to Hedera Testnet)
    const activeAccountId = facilitatorAccountId || process.env.HEDERA_ACCOUNT_ID;
    const activePrivateKey = facilitatorPrivateKey || process.env.HEDERA_PRIVATE_KEY;

    if (!activeAccountId || !activePrivateKey) {
        return {
            settled: false,
            facilitatorType: "UNAVAILABLE",
            limitationReason: "No external facilitator URL configured and no local facilitator operator credentials available in environment. Payment payload verified but settlement cannot be broadcast.",
            verifiedPayload: verification
        };
    }

    console.log(`[x402_ENGINE] Executing x402 settlement via Local Facilitator (Fee Payer: ${activeAccountId})...`);
    const client = Client.forTestnet();

    try {
        const key = PrivateKey.fromStringDer(activePrivateKey.trim());
        client.setOperator(activeAccountId, key);

        const txBytes = Buffer.from(paymentPayload.payload.transaction, "base64");
        const tx = TransferTransaction.fromBytes(txBytes);

        const response = await tx.execute(client);
        const receipt = await response.getReceipt(client);
        const status = receipt.status.toString();
        const transactionId = response.transactionId.toString();

        if (status !== "SUCCESS") {
            throw new Error(`x402 on-chain settlement failed with status: ${status}`);
        }

        console.log(`[x402_ENGINE] x402 settlement verified on Hedera Testnet! Transaction ID: ${transactionId}`);

        return {
            settled: true,
            facilitatorType: "LOCAL_OPERATOR",
            status: "SUCCESS",
            transactionId,
            payerAccountId: verification.payerAccountId,
            payToAccountId: verification.payToAccountId,
            amountTinybars: verification.amountTinybars,
            consensusTimestamp: receipt.consensusTimestamp ? receipt.consensusTimestamp.toString() : null
        };
    } finally {
        client.close();
    }
}

module.exports = {
    X402_VERSION,
    createPaymentRequirements,
    createPaymentPayload,
    verifyPaymentPayload,
    settleX402Payment
};

