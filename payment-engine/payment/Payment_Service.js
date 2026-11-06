"use strict";

require("dotenv").config();
const crypto = require("node:crypto");

const { validatePaymentRequest } = require("./Payment_Validator");
const { checkSpendingLimit, DEFAULT_SPENDING_LIMIT_HBAR } = require("./Spending_Limit");
const { requestHumanApproval, verifyAndConsumeApprovalToken } = require("./Human_Approval");
const { resolveNativeHederaAccount, buildTransferTransaction, signAndExecuteWithOperatorKey } = require("./Wallet_Signer");
const { verifySettlement } = require("./Settlement_Verifier");
const { defaultLogger } = require("./Hcs_Audit_Logger");
const {
    createPaymentRequirements,
    createPaymentPayload,
    settleX402Payment
} = require("./x402_Payment_Engine");

// Completed payments registry to ensure strict idempotency
const completedPayments = new Map();

/**
 * Valid Payment Engine Statuses
 */
const PaymentStatus = Object.freeze({
    RECEIVED: "RECEIVED",
    VALIDATING: "VALIDATING",
    PENDING_APPROVAL: "PENDING_APPROVAL",
    APPROVED: "APPROVED",
    REJECTED: "REJECTED",
    AWAITING_WALLET_SIGNATURE: "AWAITING_WALLET_SIGNATURE",
    PAYMENT_SUBMITTED: "PAYMENT_SUBMITTED",
    CONFIRMED: "CONFIRMED",
    FAILED: "FAILED"
});

/**
 * Orchestrates the complete payment lifecycle for GPU Router leases.
 *
 * @param {Object} params - Payment request parameters
 * @param {string} params.requestId - Unique payment request ID
 * @param {string} params.receiverAccountId - Destination account ID (0.0.xxxx)
 * @param {number} params.amount - Payment amount in HBAR
 * @param {string} [params.currency="HBAR"] - Currency (must be HBAR)
 * @param {string} [params.network="testnet"] - Hedera network
 * @param {string} [params.senderAccountId] - Sender/payer account ID
 * @param {Object} [params.provider] - GPU provider metadata { providerId, gpuModel, durationHours, ratePerHour }
 * @param {string} [params.protocol="native"] - "native" or "x402"
 * @param {number|boolean} [params.mockApprovalDecision=null] - Optional programmatic decision for automated testing
 * @param {Function} [params.walletSignerFn=null] - Optional custom wallet signer function (for HashPack / mock)
 * @param {Object} [params.options] - Execution options { skipHcsLogging, skipSettlementWait }
 * @returns {Promise<Object>} Final structured payment result
 */
async function processPayment({
    requestId,
    receiverAccountId,
    amount,
    currency = "HBAR",
    network = "testnet",
    senderAccountId = null,
    provider = null,
    protocol = "native",
    mockApprovalDecision = null,
    walletSignerFn = null,
    options = {}
}) {
    const paymentId = `pay_${crypto.randomBytes(12).toString("hex")}`;
    const logger = options.logger || defaultLogger;

    let currentStatus = PaymentStatus.RECEIVED;

    // 1. Check idempotency: if this requestId was already completed, return cached result
    if (requestId && completedPayments.has(requestId)) {
        console.log(`[PAYMENT_SERVICE] Request '${requestId}' was previously processed. Returning recorded payment.`);
        return {
            ...completedPayments.get(requestId),
            isDuplicate: true
        };
    }

    console.log(`\n============================================================`);
    console.log(`[PAYMENT_SERVICE] Initiating Payment [${paymentId}]`);
    console.log(`Request ID: ${requestId || "auto-generated"}`);
    console.log(`Protocol:   ${protocol.toUpperCase()}`);
    console.log(`Receiver:   ${receiverAccountId}`);
    console.log(`Amount:     ${amount} ${currency}`);
    console.log(`============================================================`);

    // Audit Log: RECEIVED
    await logger.logEvent({
        paymentId,
        requestId,
        eventType: "PAYMENT_REQUEST_RECEIVED",
        status: currentStatus,
        details: { receiverAccountId, amount, currency, network, protocol, provider }
    });

    try {
        // 2. STATUS: VALIDATING
        currentStatus = PaymentStatus.VALIDATING;
        const validated = validatePaymentRequest({
            requestId: requestId || paymentId,
            senderAccountId,
            receiverAccountId,
            amount,
            currency,
            network,
            provider
        });

        await logger.logEvent({
            paymentId,
            requestId: validated.requestId,
            eventType: "VALIDATION_SUCCESS",
            status: currentStatus,
            details: { validated }
        });

        // 3. Spending Limit Policy Evaluation
        const limitCheck = checkSpendingLimit(validated.amount);
        console.log(`[PAYMENT_SERVICE] Spending Policy: ${limitCheck.message}`);

        await logger.logEvent({
            paymentId,
            requestId: validated.requestId,
            eventType: "SPENDING_LIMIT_CHECK",
            status: currentStatus,
            details: limitCheck
        });

        let approvalToken = null;

        // 4. Human Approval (if required)
        if (limitCheck.requiresApproval) {
            currentStatus = PaymentStatus.PENDING_APPROVAL;
            await logger.logEvent({
                paymentId,
                requestId: validated.requestId,
                eventType: "HUMAN_APPROVAL_REQUESTED",
                status: currentStatus,
                details: { amount: validated.amount, limit: limitCheck.spendingLimit }
            });

            const approvalResult = await requestHumanApproval({
                requestId: validated.requestId,
                receiverAccountId: validated.receiverAccountId,
                amount: validated.amount,
                currency: validated.currency,
                network: validated.network,
                provider: validated.provider,
                spendingLimit: limitCheck.spendingLimit,
                mockDecision: mockApprovalDecision
            });

            if (!approvalResult.approved) {
                currentStatus = PaymentStatus.REJECTED;
                await logger.logEvent({
                    paymentId,
                    requestId: validated.requestId,
                    eventType: "HUMAN_APPROVAL_REJECTED",
                    status: currentStatus,
                    details: approvalResult
                });

                return {
                    success: false,
                    paymentId,
                    requestId: validated.requestId,
                    status: currentStatus,
                    amount: validated.amount,
                    currency: validated.currency,
                    receiverAccountId: validated.receiverAccountId,
                    message: approvalResult.message || "Payment rejected by human operator."
                };
            }

            currentStatus = PaymentStatus.APPROVED;
            approvalToken = approvalResult.approvalToken;

            // Verify and consume token to prevent replay
            verifyAndConsumeApprovalToken(approvalToken, {
                requestId: validated.requestId,
                receiverAccountId: validated.receiverAccountId,
                amount: validated.amount,
                currency: validated.currency,
                network: validated.network
            });

            await logger.logEvent({
                paymentId,
                requestId: validated.requestId,
                eventType: "HUMAN_APPROVAL_GRANTED",
                status: currentStatus,
                details: { approved: true }
            });
        } else {
            currentStatus = PaymentStatus.APPROVED;
        }

        // 5. STATUS: AWAITING_WALLET_SIGNATURE
        currentStatus = PaymentStatus.AWAITING_WALLET_SIGNATURE;
        const payerAccountId = validated.senderAccountId || process.env.HEDERA_ACCOUNT_ID;

        await logger.logEvent({
            paymentId,
            requestId: validated.requestId,
            eventType: "WALLET_SIGNATURE_REQUESTED",
            status: currentStatus,
            details: { payerAccountId, receiverAccountId: validated.receiverAccountId, amount: validated.amount }
        });

        // 6. Build and Execute Transaction based on protocol
        let submissionResult;

        if (protocol.toLowerCase() === "x402") {
            // === REAL x402 PROTOCOL FLOW ===
            console.log(`[PAYMENT_SERVICE] Generating x402 Payment Requirements...`);
            const requirements = createPaymentRequirements({
                receiverAccountId: validated.receiverAccountId,
                amountHbar: validated.amount,
                feePayer: payerAccountId,
                description: validated.provider ? `Lease ${validated.provider.gpuModel}` : "GPU Lease Payment"
            });

            // Construct Hedera TransferTransaction
            const builtTx = buildTransferTransaction({
                senderAccountId: payerAccountId,
                receiverAccountId: validated.receiverAccountId,
                amountHbar: validated.amount,
                memo: `x402-${validated.requestId}`
            });

            let signedTxBase64;
            if (typeof walletSignerFn === "function") {
                signedTxBase64 = await walletSignerFn({
                    transactionBase64: builtTx.base64Transaction,
                    requirements,
                    senderAccountId: payerAccountId
                });
            } else {
                signedTxBase64 = builtTx.base64Transaction;
            }

            // Create standard x402 v2 PaymentPayload
            const payload = createPaymentPayload({
                requirements,
                transactionBase64: signedTxBase64
            });

            // Execute x402 settlement
            currentStatus = PaymentStatus.PAYMENT_SUBMITTED;
            await logger.logEvent({
                paymentId,
                requestId: validated.requestId,
                eventType: "PAYMENT_SUBMITTED",
                status: currentStatus,
                details: { protocol: "x402", requirements }
            });

            submissionResult = await settleX402Payment({
                paymentPayload: payload,
                facilitatorAccountId: payerAccountId,
                facilitatorPrivateKey: process.env.HEDERA_PRIVATE_KEY
            });

        } else {
            // === NATIVE HBAR TRANSFER FLOW ===
            const builtTx = buildTransferTransaction({
                senderAccountId: payerAccountId,
                receiverAccountId: validated.receiverAccountId,
                amountHbar: validated.amount,
                memo: `gpu-lease-${validated.requestId}`
            });

            currentStatus = PaymentStatus.PAYMENT_SUBMITTED;
            await logger.logEvent({
                paymentId,
                requestId: validated.requestId,
                eventType: "PAYMENT_SUBMITTED",
                status: currentStatus,
                details: { protocol: "native", transactionId: builtTx.transactionId }
            });

            if (typeof walletSignerFn === "function") {
                submissionResult = await walletSignerFn({
                    transactionBase64: builtTx.base64Transaction,
                    senderAccountId: payerAccountId,
                    receiverAccountId: validated.receiverAccountId,
                    amount: validated.amount
                });
            } else {
                // Backend testnet operator execution
                submissionResult = await signAndExecuteWithOperatorKey({
                    transactionOrBytes: builtTx.base64Transaction,
                    operatorAccountId: payerAccountId,
                    operatorPrivateKeyDer: process.env.HEDERA_PRIVATE_KEY
                });
            }
        }

        const transactionId = submissionResult.transactionId;
        console.log(`[PAYMENT_SERVICE] Transaction submitted! Tx ID: ${transactionId}`);

        // 7. STATUS: CONFIRMED - Independent Settlement Verification
        let settlementRecord = null;
        if (!options.skipSettlementWait) {
            console.log(`[PAYMENT_SERVICE] Independently verifying settlement on Hedera Testnet...`);
            settlementRecord = await verifySettlement(transactionId, {
                senderAccountId: payerAccountId,
                receiverAccountId: validated.receiverAccountId,
                amountHbar: validated.amount
            });

            if (!settlementRecord.settled || !settlementRecord.verified) {
                throw new Error(`Settlement verification failed: ${settlementRecord.error || "Transaction not settled on mirror node"}`);
            }
        } else {
            settlementRecord = {
                verified: true,
                settled: true,
                status: "SUCCESS",
                transactionId
            };
        }

        currentStatus = PaymentStatus.CONFIRMED;
        console.log(`[PAYMENT_SERVICE] ✅ Payment confirmed and settled on Hedera Testnet!`);

        // Audit Log: SETTLEMENT_VERIFIED
        await logger.logEvent({
            paymentId,
            requestId: validated.requestId,
            eventType: "SETTLEMENT_VERIFIED",
            status: currentStatus,
            transactionId,
            details: { settlementRecord }
        });

        const finalResult = {
            success: true,
            paymentId,
            requestId: validated.requestId,
            status: currentStatus,
            protocol: protocol.toLowerCase(),
            senderAccountId: payerAccountId,
            receiverAccountId: validated.receiverAccountId,
            amount: validated.amount,
            currency: validated.currency,
            network: validated.network,
            transactionId,
            provider: validated.provider,
            settlement: settlementRecord,
            timestamp: new Date().toISOString()
        };

        // Store for idempotency
        completedPayments.set(validated.requestId, finalResult);
        return finalResult;

    } catch (error) {
        currentStatus = PaymentStatus.FAILED;
        console.error(`[PAYMENT_SERVICE] ❌ Payment failed: ${error.message}`);

        await logger.logEvent({
            paymentId,
            requestId: requestId || paymentId,
            eventType: "PAYMENT_FAILED",
            status: currentStatus,
            details: { error: error.message, stack: error.stack }
        });

        return {
            success: false,
            paymentId,
            requestId: requestId || paymentId,
            status: currentStatus,
            receiverAccountId,
            amount,
            currency,
            error: error.message
        };
    }
}

/**
 * Backward compatible entry point matching original `makePayment(receiverAccountId, amount)`
 */
async function makePayment(receiverAccountId, amount, options = {}) {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    return processPayment({
        requestId,
        receiverAccountId,
        amount,
        currency: "HBAR",
        network: "testnet",
        protocol: options.protocol || "native",
        mockApprovalDecision: options.mockApprovalDecision !== undefined ? options.mockApprovalDecision : null,
        walletSignerFn: options.walletSignerFn || null,
        options
    });
}

/**
 * Resets the completed payments store (for test isolation)
 */
function resetPaymentServiceState() {
    completedPayments.clear();
}

module.exports = {
    processPayment,
    makePayment,
    PaymentStatus,
    resetPaymentServiceState
};
