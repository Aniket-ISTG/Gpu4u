"use strict";

/**
 * Settlement Verifier for Hedera Testnet Transactions
 * Independently validates on-chain transaction execution and transfer balances via Hedera Mirror Node.
 */

const MIRROR_NODE_TESTNET_URL = "https://testnet.mirrornode.hedera.com";

/**
 * Normalizes Hedera Transaction ID from SDK format (0.0.x@sec.nano) to Mirror Node format (0.0.x-sec-nano).
 */
function normalizeTransactionId(txId) {
    if (!txId || typeof txId !== "string") {
        throw new Error("Invalid transaction ID");
    }
    // Replace '@' with '-' and then replace '.' with '-' in the timestamp part
    return txId.trim().replace("@", "-").replace(/\.(\d+)$/, "-$1");
}

/**
 * Verifies transaction settlement on Hedera Testnet.
 * @param {string} rawTxId - The Hedera transaction ID (in either SDK or Mirror Node format)
 * @param {Object} expected - The expected transaction details { senderAccountId, receiverAccountId, amountHbar }
 * @param {number} [maxRetries=6] - Retries while waiting for mirror node ingestion
 * @param {number} [retryDelayMs=2000] - Delay between retries
 * @returns {Promise<Object>} Verification details
 */
async function verifySettlement(rawTxId, expected = {}, maxRetries = 6, retryDelayMs = 2000) {
    const formattedTxId = normalizeTransactionId(rawTxId);
    const url = `${MIRROR_NODE_TESTNET_URL}/api/v1/transactions/${formattedTxId}`;

    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`[SETTLEMENT_VERIFIER] Inquiring Mirror Node for tx '${formattedTxId}' (attempt ${attempt}/${maxRetries})...`);
            const res = await fetch(url);

            if (res.status === 404) {
                // Mirror node may take 2-4 seconds to ingest the transaction
                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, retryDelayMs));
                    continue;
                }
                throw new Error(`Transaction '${formattedTxId}' not yet found on Hedera Testnet mirror node after ${maxRetries} attempts.`);
            }

            if (!res.ok) {
                throw new Error(`Mirror Node returned HTTP ${res.status}: ${res.statusText}`);
            }

            const data = await res.json();
            const txList = data.transactions;

            if (!Array.isArray(txList) || txList.length === 0) {
                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, retryDelayMs));
                    continue;
                }
                throw new Error(`No transaction record returned by mirror node for '${formattedTxId}'`);
            }

            const record = txList[0];
            const resultStatus = record.result;

            if (resultStatus !== "SUCCESS") {
                return {
                    verified: false,
                    settled: false,
                    status: resultStatus,
                    transactionId: formattedTxId,
                    consensusTimestamp: record.consensus_timestamp,
                    error: `Transaction failed on-chain with status: ${resultStatus}`
                };
            }

            // Verify specific balance transfers if expected parameters are provided
            let transfersVerified = true;
            let transferNotes = [];

            if (expected.receiverAccountId && typeof expected.amountHbar === "number") {
                const expectedTinybars = BigInt(Math.round(expected.amountHbar * 100_000_000));
                const transfers = record.transfers || [];

                const receiverTransfer = transfers.find(t => t.account === expected.receiverAccountId);
                if (!receiverTransfer) {
                    transfersVerified = false;
                    transferNotes.push(`Receiver account ${expected.receiverAccountId} not found in transaction transfers`);
                } else if (BigInt(receiverTransfer.amount) !== expectedTinybars) {
                    transfersVerified = false;
                    transferNotes.push(`Receiver credited amount (${receiverTransfer.amount} tinybars) is not exactly the expected ${expectedTinybars} tinybars`);
                }
            }

            return {
                verified: transfersVerified,
                settled: true,
                status: "SUCCESS",
                transactionId: formattedTxId,
                consensusTimestamp: record.consensus_timestamp,
                chargedTxFee: record.charged_tx_fee,
                transfers: record.transfers,
                transferNotes,
                explorerUrl: `https://hashscan.io/testnet/transaction/${formattedTxId}`
            };

        } catch (err) {
            lastError = err;
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, retryDelayMs));
            }
        }
    }

    throw lastError || new Error(`Failed to verify settlement for transaction '${formattedTxId}'`);
}

module.exports = {
    verifySettlement,
    normalizeTransactionId
};

