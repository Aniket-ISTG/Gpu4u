"use strict";

const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const crypto = require("node:crypto");

// Store approval decisions and single-use tokens
const approvalDecisions = new Map();
const consumedTokens = new Set();
const rejectedRequests = new Set();

const DEFAULT_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Creates an approval token bound to exact payment parameters.
 */
function generateApprovalToken({ requestId, receiverAccountId, amount, currency, network }) {
    const nonce = crypto.randomBytes(16).toString("hex");
    const payload = `${requestId}|${receiverAccountId}|${amount}|${currency}|${network}|${Date.now()}|${nonce}`;
    const hash = crypto.createHash("sha256").update(payload).digest("hex");
    return `appr_${hash.substring(0, 32)}`;
}

/**
 * Requests human approval via terminal prompt or programmatic decision.
 * Strictly binds approval to the exact payment parameters.
 */
async function requestHumanApproval({
    requestId,
    receiverAccountId,
    amount,
    currency = "HBAR",
    network = "hedera:testnet",
    provider = null,
    spendingLimit = 5,
    timeoutMs = 60000,
    mockDecision = null // for automated tests
}) {
    if (!requestId || !receiverAccountId || typeof amount !== "number") {
        throw new Error("Missing required payment details for human approval");
    }

    // Check if this request was previously rejected
    if (rejectedRequests.has(requestId)) {
        return {
            approved: false,
            status: "REJECTED",
            requestId,
            reason: "Request was previously rejected by human operator and cannot be re-executed.",
            timestamp: new Date().toISOString()
        };
    }

    console.log("\n============================================================");
    console.log("            🚨 HUMAN APPROVAL REQUIRED 🚨                  ");
    console.log("============================================================");
    console.log(` Request ID:     ${requestId}`);
    console.log(` Network:        ${network}`);
    console.log(` Receiver:       ${receiverAccountId}`);
    console.log(` Payment Amount: ${amount} ${currency}`);
    console.log(` Spending Limit: ${spendingLimit} ${currency} (Exceeded by ${Math.round((amount - spendingLimit) * 1e8) / 1e8} ${currency})`);
    if (provider) {
        console.log(` GPU Provider:   ${provider.providerId || "N/A"}`);
        console.log(` GPU Model:      ${provider.gpuModel || "N/A"}`);
        if (provider.durationHours && provider.ratePerHour) {
            console.log(` Compute Plan:   ${provider.durationHours} hrs @ ${provider.ratePerHour} ${currency}/hr`);
        }
    }
    console.log("============================================================");

    let approved = false;

    if (mockDecision !== null) {
        // Programmatic decision (for automated test suite)
        approved = Boolean(mockDecision);
        console.log(`[AUTOMATION] Decision injected: ${approved ? "YES (APPROVED)" : "NO (REJECTED)"}`);
    } else {
        const rl = readline.createInterface({
            input: stdin,
            output: stdout
        });

        try {
            const answer = await rl.question(
                "Do you authorize this exact GPU payment? Type 'yes' to approve, 'no' to reject: ",
                { signal: AbortSignal.timeout(timeoutMs) }
            );
            approved = answer.trim().toLowerCase() === "yes" || answer.trim().toLowerCase() === "y";
        } catch (err) {
            console.error(err.name === "AbortError" ? `No answer within ${Math.round(timeoutMs / 1000)}s: treated as rejected.` : `Failed to read user input: ${err.message}`);
            approved = false;
        } finally {
            rl.close();
        }
    }

    const decisionTime = Date.now();

    if (!approved) {
        rejectedRequests.add(requestId);
        const decisionRecord = {
            approved: false,
            status: "REJECTED",
            requestId,
            receiverAccountId,
            amount,
            currency,
            network,
            decisionTimestamp: new Date(decisionTime).toISOString(),
            message: "Payment rejected by human operator."
        };
        approvalDecisions.set(requestId, decisionRecord);
        return decisionRecord;
    }

    // Generate single-use approval token
    const approvalToken = generateApprovalToken({
        requestId,
        receiverAccountId,
        amount,
        currency,
        network
    });

    const expiresAt = decisionTime + DEFAULT_EXPIRY_MS;

    const decisionRecord = {
        approved: true,
        status: "APPROVED",
        requestId,
        receiverAccountId,
        amount,
        currency,
        network,
        approvalToken,
        expiresAt,
        decisionTimestamp: new Date(decisionTime).toISOString(),
        message: "Payment approved by human operator. Proceeding to wallet authorization."
    };

    approvalDecisions.set(requestId, decisionRecord);
    return decisionRecord;
}

/**
 * Validates and consumes an approval token before executing a payment.
 * Ensures the token matches the exact transaction and has not expired or been reused.
 */
function verifyAndConsumeApprovalToken(token, expectedDetails) {
    if (!token || typeof token !== "string") {
        throw new Error("Missing approval token for transaction requiring approval");
    }

    if (consumedTokens.has(token)) {
        throw new Error(`Approval token '${token}' has already been consumed. Replay attacks are prohibited.`);
    }

    const { requestId, receiverAccountId, amount, currency, network } = expectedDetails;

    const record = approvalDecisions.get(requestId);
    if (!record) {
        throw new Error(`No approval decision found for request ID '${requestId}'`);
    }

    if (!record.approved) {
        throw new Error(`Request '${requestId}' was rejected by human operator and cannot be executed`);
    }

    if (record.approvalToken !== token) {
        throw new Error("Approval token does not match the issued token for this request");
    }

    // Verify parameter integrity
    if (
        record.receiverAccountId !== receiverAccountId ||
        record.amount !== amount ||
        record.currency !== currency ||
        record.network !== network
    ) {
        throw new Error("Approval token parameter mismatch: payment parameters altered after approval!");
    }

    // Verify expiry
    if (Date.now() > record.expiresAt) {
        throw new Error(`Approval token for request '${requestId}' has expired. A new approval must be requested.`);
    }

    // Consume token
    consumedTokens.add(token);
    return {
        valid: true,
        consumed: true,
        token,
        verifiedAt: new Date().toISOString()
    };
}

/**
 * Resets approval state (for test isolation)
 */
function resetApprovalState() {
    approvalDecisions.clear();
    consumedTokens.clear();
    rejectedRequests.clear();
}

module.exports = {
    requestHumanApproval,
    verifyAndConsumeApprovalToken,
    resetApprovalState
};
