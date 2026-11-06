"use strict";

const express = require("express");
const { Transaction, TransferTransaction } = require("@hiero-ledger/sdk");
const { x402Facilitator } = require("@x402/core/facilitator");
const {
    createHederaVerifyPayerSignature,
    createHederaPreflightTransfer,
    createHederaSignAndSubmitTransaction,
    createHederaClient,
} = require("@x402/hedera");
const { ExactHederaScheme } = require("@x402/hedera/exact/facilitator");
const { parsePrivateKey } = require("./keys");

const NETWORK = "hedera:testnet";

/**
 * A facilitator signer backed by the simulated ledger. It plugs into the
 * official facilitator scheme, so verification (transaction layout, exact
 * amount, payer signature, fee-payer safety) is the real x402 code. Only
 * the final submission differs: it settles on the simulated ledger.
 */
function createSimulatedFacilitatorSigner({ ledger, feePayerId }) {
    return {
        getAddresses: () => [feePayerId],
        verifyPayerSignature: async ({ payer, transaction }) => {
            const key = ledger.keyOf(payer);
            if (!key) return { ok: false, reason: "unknown_payer", message: `Unknown payer ${payer}` };
            const tx = Transaction.fromBytes(Buffer.from(transaction, "base64"));
            return key.verifyTransaction(tx) ? { ok: true } : { ok: false, reason: "bad_signature", message: "Payer signature is invalid" };
        },
        preflightTransfer: async ({ payer, amount }) => {
            return ledger.balanceOf(payer) >= BigInt(amount)
                ? { ok: true }
                : { ok: false, reason: "insufficient_balance", message: `Payer ${payer} cannot cover ${amount} tinybars` };
        },
        signAndSubmitTransaction: async (transactionBase64) => {
            const tx = TransferTransaction.fromBytes(Buffer.from(transactionBase64, "base64"));
            const transfers = [];
            for (const [account, hbar] of tx.hbarTransfers) {
                transfers.push({ account: account.toString(), amount: BigInt(hbar.toTinybars().toString()) });
            }
            const result = ledger.submit({
                transactionId: tx.transactionId.toString(),
                transfers,
                feePayer: feePayerId,
                memo: tx.transactionMemo || "",
            });
            return { transactionId: result.transactionId };
        },
    };
}

/** A facilitator signer that settles on the real Hedera testnet. The fee payer pays the network fee. */
function createTestnetFacilitatorSigner({ feePayerId, feePayerPrivateKey, mirrorUrl }) {
    const key = parsePrivateKey(feePayerPrivateKey);
    return {
        getAddresses: () => [feePayerId],
        verifyPayerSignature: createHederaVerifyPayerSignature({ mirrorNodeUrl: mirrorUrl }),
        preflightTransfer: createHederaPreflightTransfer({ mirrorNodeUrl: mirrorUrl }),
        signAndSubmitTransaction: createHederaSignAndSubmitTransaction(createHederaClient, key),
    };
}

function createFacilitator(signer) {
    return new x402Facilitator().register(NETWORK, new ExactHederaScheme(signer));
}

/**
 * Standard x402 facilitator HTTP endpoints: GET /supported, POST /verify, POST /settle.
 * Mounted in-process for local and simulated modes, so the resource server uses the
 * same HTTP client path it would use against Blocky402 or x402.org.
 */
function createFacilitatorRouter(facilitator) {
    const router = express.Router();
    router.use(express.json({ limit: "256kb" }));

    router.get("/supported", async (_req, res) => {
        res.json(facilitator.getSupported());
    });

    const handler = (method) => async (req, res) => {
        const { paymentPayload, paymentRequirements } = req.body || {};
        if (!paymentPayload || !paymentRequirements) {
            return res.status(400).json({ error: "paymentPayload and paymentRequirements are required" });
        }
        try {
            res.json(await facilitator[method](paymentPayload, paymentRequirements));
        } catch (error) {
            res.status(400).json({ success: false, isValid: false, errorReason: "facilitator_error", errorMessage: error.message });
        }
    };
    router.post("/verify", handler("verify"));
    router.post("/settle", handler("settle"));
    return router;
}

module.exports = {
    NETWORK,
    createSimulatedFacilitatorSigner,
    createTestnetFacilitatorSigner,
    createFacilitator,
    createFacilitatorRouter,
};
