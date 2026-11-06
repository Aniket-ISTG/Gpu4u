"use strict";

// These tests never touch the network. They need an account ID only so a transfer can be built;
// nothing is signed or sent with it.
process.env.HEDERA_ACCOUNT_ID = process.env.HEDERA_ACCOUNT_ID || "0.0.1001";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { validatePaymentRequest, resetProcessedRequests } = require("../payment/Payment_Validator");
const { checkSpendingLimit } = require("../payment/Spending_Limit");
const { requestHumanApproval, verifyAndConsumeApprovalToken, resetApprovalState } = require("../payment/Human_Approval");
const { HcsAuditLogger } = require("../payment/Hcs_Audit_Logger");
const { createPaymentRequirements, createPaymentPayload, verifyPaymentPayload } = require("../payment/x402_Payment_Engine");
const { buildTransferTransaction } = require("../payment/Wallet_Signer");
const { processPayment, PaymentStatus, resetPaymentServiceState } = require("../payment/Payment_Service");

describe("Core Payment Engine Unit Tests (Automated & Mocked)", () => {

    beforeEach(() => {
        resetProcessedRequests();
        resetApprovalState();
        resetPaymentServiceState();
    });

    // SCENARIO 1: Payment of 2 HBAR (Within 5 HBAR Limit)
    it("Scenario 1: Payment of 2 HBAR is within autonomous spending limit of 5 HBAR", () => {
        const decision = checkSpendingLimit(2);
        assert.equal(decision.allowed, true);
        assert.equal(decision.requiresApproval, false);
        assert.equal(decision.spendingLimit, 5);
        assert.equal(decision.requestedAmount, 2);
        assert.equal(decision.excessAmount, 0);
    });

    // SCENARIO 2: Payment of exactly 5 HBAR (Within Limit)
    it("Scenario 2: Payment of exactly 5 HBAR is within autonomous spending limit", () => {
        const decision = checkSpendingLimit(5);
        assert.equal(decision.allowed, true);
        assert.equal(decision.requiresApproval, false);
        assert.equal(decision.spendingLimit, 5);
        assert.equal(decision.requestedAmount, 5);
        assert.equal(decision.excessAmount, 0);
    });

    // SCENARIO 3: Payment of 6 HBAR (Requires Human Approval)
    it("Scenario 3: Payment of 6 HBAR exceeds 5 HBAR and requires explicit human approval", () => {
        const decision = checkSpendingLimit(6);
        assert.equal(decision.allowed, false);
        assert.equal(decision.requiresApproval, true);
        assert.equal(decision.spendingLimit, 5);
        assert.equal(decision.requestedAmount, 6);
        assert.equal(decision.excessAmount, 1);
    });

    // SCENARIO 4: Human Approves Payment
    it("Scenario 4: Human approves payment -> generates single-use token and advances", async () => {
        const approval = await requestHumanApproval({
            requestId: "req_test_approve_1",
            receiverAccountId: "0.0.11326195",
            amount: 6,
            currency: "HBAR",
            network: "hedera:testnet",
            spendingLimit: 5,
            mockDecision: true
        });

        assert.equal(approval.approved, true);
        assert.equal(approval.status, "APPROVED");
        assert.ok(approval.approvalToken);

        // Verification of token succeeds on first use
        const verification = verifyAndConsumeApprovalToken(approval.approvalToken, {
            requestId: "req_test_approve_1",
            receiverAccountId: "0.0.11326195",
            amount: 6,
            currency: "HBAR",
            network: "hedera:testnet"
        });
        assert.equal(verification.consumed, true);

        // Replay of consumed token is rejected
        assert.throws(() => {
            verifyAndConsumeApprovalToken(approval.approvalToken, {
                requestId: "req_test_approve_1",
                receiverAccountId: "0.0.11326195",
                amount: 6,
                currency: "HBAR",
                network: "hedera:testnet"
            });
        }, /already been consumed/);
    });

    // SCENARIO 5: Human Rejects Payment
    it("Scenario 5: Human rejects payment -> status is REJECTED and no transfer executes", async () => {
        const mockLogger = new HcsAuditLogger({ enabled: false });
        let walletCalled = false;

        const result = await processPayment({
            requestId: "req_test_reject_1",
            receiverAccountId: "0.0.11326195",
            amount: 25,
            currency: "HBAR",
            mockApprovalDecision: false,
            walletSignerFn: async () => {
                walletCalled = true;
                return { transactionId: "0.0.123@1.1" };
            },
            options: { logger: mockLogger }
        });

        assert.equal(result.success, false);
        assert.equal(result.status, PaymentStatus.REJECTED);
        assert.equal(walletCalled, false, "Wallet signer must NOT be invoked when human rejects");

        // Verify rejection recorded in audit logs
        const logs = mockLogger.getLogs("req_test_reject_1");
        assert.ok(logs.some(l => l.eventType === "HUMAN_APPROVAL_REJECTED"));
    });

    // SCENARIO 6: Wallet Signature Rejection
    it("Scenario 6: Wallet signature rejection -> payment fails gracefully without settlement", async () => {
        const mockLogger = new HcsAuditLogger({ enabled: false });

        const result = await processPayment({
            requestId: "req_test_wallet_reject",
            receiverAccountId: "0.0.11326195",
            amount: 5,
            currency: "HBAR",
            walletSignerFn: async () => {
                throw new Error("User rejected transaction in HashPack");
            },
            options: { logger: mockLogger }
        });

        assert.equal(result.success, false);
        assert.equal(result.status, PaymentStatus.FAILED);
        assert.match(result.error, /User rejected/);

        const logs = mockLogger.getLogs("req_test_wallet_reject");
        assert.ok(logs.some(l => l.eventType === "PAYMENT_FAILED"));
    });

    // SCENARIO 7: Invalid Receiver Account ID
    it("Scenario 7: Invalid receiver account ID fails validation", () => {
        assert.throws(() => {
            validatePaymentRequest({
                requestId: "req_bad_rcv",
                receiverAccountId: "invalid.account.id",
                amount: 5,
                currency: "HBAR"
            });
        }, /Invalid receiver account ID/);
    });

    // SCENARIO 8: Negative or Zero Amount
    it("Scenario 8: Negative or zero amount fails validation", () => {
        assert.throws(() => {
            validatePaymentRequest({
                requestId: "req_neg_amt",
                receiverAccountId: "0.0.11326195",
                amount: -5,
                currency: "HBAR"
            });
        }, /greater than zero/);

        assert.throws(() => {
            validatePaymentRequest({
                requestId: "req_zero_amt",
                receiverAccountId: "0.0.11326195",
                amount: 0,
                currency: "HBAR"
            });
        }, /greater than zero/);
    });

    // SCENARIO 9: Unsupported Currency
    it("Scenario 9: Unsupported currency fails validation", () => {
        assert.throws(() => {
            validatePaymentRequest({
                requestId: "req_bad_curr",
                receiverAccountId: "0.0.11326195",
                amount: 5,
                currency: "ETH"
            });
        }, /Unsupported payment currency/);
    });

    // SCENARIO 10: Wrong Network Blocked
    it("Scenario 10: Wrong network is blocked", () => {
        assert.throws(() => {
            validatePaymentRequest({
                requestId: "req_wrong_net",
                receiverAccountId: "0.0.11326195",
                amount: 5,
                currency: "HBAR",
                network: "mainnet"
            });
        }, /Invalid or unsupported network/);
    });

    // SCENARIO 11: Idempotency / Duplicate Request Prevention
    it("Scenario 11: Duplicate request ID prevents duplicate execution", async () => {
        const mockLogger = new HcsAuditLogger({ enabled: false });
        let executionCount = 0;

        const first = await processPayment({
            requestId: "req_idempotent_test",
            receiverAccountId: "0.0.11326195",
            amount: 5,
            currency: "HBAR",
            walletSignerFn: async () => {
                executionCount++;
                return { transactionId: "0.0.11326170@1700000000.000000001" };
            },
            options: { logger: mockLogger, skipSettlementWait: true }
        });

        assert.equal(first.success, true);
        assert.equal(executionCount, 1);

        // Resubmit the exact same request
        const second = await processPayment({
            requestId: "req_idempotent_test",
            receiverAccountId: "0.0.11326195",
            amount: 5,
            currency: "HBAR",
            walletSignerFn: async () => {
                executionCount++;
                return { transactionId: "0.0.11326170@1700000000.000000002" };
            },
            options: { logger: mockLogger, skipSettlementWait: true }
        });

        assert.equal(second.success, true);
        assert.equal(second.isDuplicate, true);
        assert.equal(executionCount, 1, "Duplicate payment must NOT re-execute transaction!");
    });

    // SCENARIO 12: Duplicate Request with Altered Details Throws Error
    it("Scenario 12: Duplicate request with altered parameters is rejected as tampering", () => {
        validatePaymentRequest({
            requestId: "req_tamper_check",
            receiverAccountId: "0.0.11326195",
            amount: 5
        });

        assert.throws(() => {
            validatePaymentRequest({
                requestId: "req_tamper_check",
                receiverAccountId: "0.0.99999999", // Altered receiver
                amount: 5
            });
        }, /Duplicate request ID 'req_tamper_check' detected with altered payment details/);
    });

    // SCENARIO 13: x402 Protocol Specification Adherence
    it("Scenario 13: x402 Payment Requirements and Payload follow official v2 standard", async () => {
        const requirements = createPaymentRequirements({
            receiverAccountId: "0.0.11326195",
            amountHbar: 2.5,
            feePayer: "0.0.11326170",
            description: "NVIDIA H100 1-hour lease"
        });

        assert.equal(requirements.scheme, "exact");
        assert.equal(requirements.network, "hedera:testnet");
        assert.equal(requirements.asset, "0.0.0");
        assert.equal(requirements.amount, "250000000"); // 2.5 HBAR = 250,000,000 tinybars
        assert.equal(requirements.payTo, "0.0.11326195");
        assert.equal(requirements.extra.feePayer, "0.0.11326170");

        // Build valid transaction
        const builtTx = buildTransferTransaction({
            senderAccountId: "0.0.11326170",
            receiverAccountId: "0.0.11326195",
            amountHbar: 2.5
        });

        const payload = createPaymentPayload({
            requirements,
            transactionBase64: builtTx.base64Transaction
        });

        assert.equal(payload.x402Version, 2);
        assert.equal(payload.accepted.scheme, "exact");
        assert.ok(payload.payload.transaction);

        // Verify payload structure
        const verification = await verifyPaymentPayload(payload, { preflight: async () => ({ ok: true }) });
        assert.equal(verification.valid, true);

        // A failing or unreachable balance check must stop the payment, never wave it through.
        const refused = await verifyPaymentPayload(payload, { preflight: async () => ({ ok: false, message: "insufficient balance" }) });
        assert.equal(refused.valid, false);
        assert.match(refused.error, /insufficient balance/);
        const unreachable = await verifyPaymentPayload(payload, { preflight: async () => { throw new Error("mirror node down"); } });
        assert.equal(unreachable.valid, false);
        assert.match(unreachable.error, /could not be completed/);
        assert.equal(verification.payToAccountId, "0.0.11326195");
        assert.equal(verification.amountTinybars, "250000000");
    });

    // SCENARIO 14: HCS Logging Resiliency (Audit failure does not corrupt payment status)
    it("Scenario 14: HCS failure does not falsely change settled payment to FAILED", async () => {
        const failingLogger = new HcsAuditLogger({ enabled: true });
        // Simulate HCS network outage while preserving in-memory fallback
        failingLogger.getClient = () => {
            throw new Error("Simulated HCS network connection timeout (DEADLINE_EXCEEDED)");
        };

        const result = await processPayment({
            requestId: "req_hcs_resilience",
            receiverAccountId: "0.0.11326195",
            amount: 5,
            currency: "HBAR",
            walletSignerFn: async () => {
                return { transactionId: "0.0.11326170@1793900000.123456789" };
            },
            options: {
                logger: failingLogger,
                skipSettlementWait: true
            }
        });

        assert.equal(result.success, true);
        assert.equal(result.status, PaymentStatus.CONFIRMED);
        assert.ok(failingLogger.inMemoryLogs.length > 0, "Audit trail was safely recorded in-memory fallback");
    });
});
