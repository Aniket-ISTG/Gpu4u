"use strict";

/**
 * Payment Validator for GPU Router Payment Engine on Hedera Testnet
 * Validates request parameters, amounts, network, provider specs, and enforces idempotency.
 */

// Cache of processed request IDs to prevent duplicate execution
const processedRequests = new Map();

/**
 * Validates a payment request.
 * @param {Object} request - The payment request object
 * @returns {Object} Validated and normalized payment details
 */
function validatePaymentRequest(request) {
    if (!request || typeof request !== "object") {
        throw new Error("Payment request must be a valid object");
    }

    const {
        requestId,
        senderAccountId,
        receiverAccountId,
        amount,
        currency = "HBAR",
        network = "testnet",
        provider
    } = request;

    // 1. Validate Request ID
    if (!requestId || typeof requestId !== "string" || requestId.trim().length === 0) {
        throw new Error("Missing or invalid 'requestId': must be a non-empty string");
    }
    const cleanRequestId = requestId.trim();

    // 2. Validate Receiver Account ID
    if (!receiverAccountId || typeof receiverAccountId !== "string" || !/^0\.0\.\d+$/.test(receiverAccountId.trim())) {
        throw new Error(`Invalid receiver account ID: '${receiverAccountId}'. Expected format '0.0.xxxx'`);
    }
    const cleanReceiverId = receiverAccountId.trim();

    // Optional Sender Account ID validation
    let cleanSenderId = null;
    if (senderAccountId) {
        if (typeof senderAccountId !== "string" || !/^0\.0\.\d+$/.test(senderAccountId.trim())) {
            throw new Error(`Invalid sender account ID: '${senderAccountId}'. Expected format '0.0.xxxx'`);
        }
        cleanSenderId = senderAccountId.trim();
        if (cleanSenderId === cleanReceiverId) {
            throw new Error("Sender and receiver account IDs cannot be the same");
        }
    }

    // 3. Validate Payment Amount
    if (typeof amount !== "number" || !Number.isFinite(amount) || isNaN(amount)) {
        throw new Error("Payment amount must be a finite number");
    }
    if (amount <= 0) {
        throw new Error("Payment amount must be greater than zero");
    }

    // Check maximum precision (HBAR has 8 decimals = 1 tinybar)
    const amountStr = amount.toString();
    const decimalParts = amountStr.split(".");
    if (decimalParts.length > 1 && decimalParts[1].length > 8) {
        throw new Error("Payment amount exceeds maximum HBAR precision (8 decimal places)");
    }

    // Safe conversion to Tinybar (1 HBAR = 100,000,000 tinybars)
    const amountTinybars = BigInt(Math.round(amount * 100_000_000));
    if (amountTinybars <= 0n) {
        throw new Error("Payment amount converted to tinybars must be positive");
    }

    // 4. Validate Currency
    if (typeof currency !== "string" || currency.trim().toUpperCase() !== "HBAR") {
        throw new Error(`Unsupported payment currency: '${currency}'. Only 'HBAR' is currently supported`);
    }
    const cleanCurrency = "HBAR";

    // 5. Validate Network
    const validNetworks = ["testnet", "hedera:testnet"];
    if (!network || typeof network !== "string" || !validNetworks.includes(network.trim().toLowerCase())) {
        throw new Error(`Invalid or unsupported network: '${network}'. Only 'testnet' / 'hedera:testnet' is supported`);
    }
    const normalizedNetwork = "hedera:testnet";

    // 6. Validate Provider Info (if provided)
    let validatedProvider = null;
    if (provider) {
        if (typeof provider !== "object") {
            throw new Error("Provider information must be an object");
        }
        const { providerId, gpuModel, durationHours, ratePerHour } = provider;
        if (!providerId || typeof providerId !== "string") {
            throw new Error("Provider information missing 'providerId'");
        }
        if (!gpuModel || typeof gpuModel !== "string") {
            throw new Error("Provider information missing 'gpuModel' (e.g. NVIDIA H100)");
        }
        if (typeof durationHours === "number" && durationHours <= 0) {
            throw new Error("Provider durationHours must be positive");
        }
        if (typeof ratePerHour === "number" && ratePerHour <= 0) {
            throw new Error("Provider ratePerHour must be positive");
        }
        if (typeof durationHours === "number" && typeof ratePerHour === "number") {
            const expectedTotal = durationHours * ratePerHour;
            // Tolerance for floating point calculation
            if (Math.abs(expectedTotal - amount) > 0.0001) {
                throw new Error(`Payment amount (${amount} HBAR) does not match provider calculated total (${durationHours} hrs * ${ratePerHour} = ${expectedTotal} HBAR)`);
            }
        }
        validatedProvider = {
            providerId: providerId.trim(),
            gpuModel: gpuModel.trim(),
            durationHours: durationHours || null,
            ratePerHour: ratePerHour || null
        };
    }

    // 7. Check Idempotency / Duplicate Requests
    const existing = processedRequests.get(cleanRequestId);
    if (existing) {
        // Verify parameters match exactly
        if (
            existing.receiverAccountId !== cleanReceiverId ||
            existing.amount !== amount ||
            existing.currency !== cleanCurrency
        ) {
            throw new Error(`Duplicate request ID '${cleanRequestId}' detected with altered payment details`);
        }
        return {
            ...existing,
            isDuplicate: true
        };
    }

    const validated = {
        valid: true,
        isDuplicate: false,
        requestId: cleanRequestId,
        senderAccountId: cleanSenderId,
        receiverAccountId: cleanReceiverId,
        amount,
        amountTinybars: amountTinybars.toString(),
        currency: cleanCurrency,
        network: normalizedNetwork,
        provider: validatedProvider,
        validatedAt: new Date().toISOString()
    };

    processedRequests.set(cleanRequestId, validated);
    return validated;
}

/**
 * Resets the processed requests store (for testing purposes)
 */
function resetProcessedRequests() {
    processedRequests.clear();
}

/**
 * Legacy compatibility wrapper
 */
function validatePayment(receiverAccountId, amount, currency = "HBAR") {
    const result = validatePaymentRequest({
        requestId: "legacy_" + Date.now() + "_" + Math.random().toString(36).substring(7),
        receiverAccountId,
        amount,
        currency,
        network: "testnet"
    });
    return {
        valid: result.valid,
        receiverAccountId: result.receiverAccountId,
        amount: result.amount,
        currency: result.currency
    };
}

module.exports = {
    validatePaymentRequest,
    validatePayment,
    resetProcessedRequests
};
