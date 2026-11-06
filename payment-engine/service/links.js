"use strict";

const HASHSCAN = "https://hashscan.io/testnet";
const MIRROR = "https://testnet.mirrornode.hedera.com";

/** 0.0.123@1700000000.123456789 to 0.0.123-1700000000-123456789, the form the mirror node API uses. */
function toMirrorTransactionId(transactionId) {
    return String(transactionId).trim().replace("@", "-").replace(/\.(\d+)$/, "-$1");
}

/**
 * Links a person can open to check a transaction on the public ledger. Simulated payments are not on
 * Hedera, so they have no links, and the caller says so instead of inventing one.
 *
 * - hashscan: the HashScan explorer page, addressed by consensus timestamp when known.
 * - mirrorApi: the mirror node REST record, a JSON document anyone can fetch and compare.
 */
function transactionLinks({ transactionId, consensusTimestamp = null, simulated, mirrorUrl = MIRROR }) {
    if (simulated || !transactionId) return { hashscan: null, mirrorApi: null };
    const hashscanKey = consensusTimestamp || String(transactionId);
    return {
        hashscan: `${HASHSCAN}/transaction/${encodeURI(hashscanKey)}`,
        mirrorApi: `${mirrorUrl.replace(/\/$/, "")}/api/v1/transactions/${toMirrorTransactionId(transactionId)}`,
    };
}

function topicLinks({ topicId, simulated, mirrorUrl = MIRROR }) {
    if (simulated || !topicId) return { hashscan: null, mirrorApi: null };
    return {
        hashscan: `${HASHSCAN}/topic/${topicId}`,
        mirrorApi: `${mirrorUrl.replace(/\/$/, "")}/api/v1/topics/${topicId}/messages`,
    };
}

function accountLinks({ accountId, simulated }) {
    if (simulated || !accountId) return { hashscan: null };
    return { hashscan: `${HASHSCAN}/account/${accountId}` };
}

module.exports = { transactionLinks, topicLinks, accountLinks, toMirrorTransactionId };
