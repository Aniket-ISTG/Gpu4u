"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { proto } = require("@hiero-ledger/proto");

/**
 * Describes the transaction a wallet returned, without any secret: how many per-node copies it holds, which
 * node and transaction ID each names, and what kind of signature each carries. Used only when the facilitator
 * rejects a payment, to see exactly what the wallet produced.
 */
function describeSignedTransaction(base64) {
    const bytes = Buffer.from(base64, "base64");
    let list;
    try {
        list = proto.TransactionList.decode(bytes).transactionList;
    } catch {
        list = [];
    }
    if (!list.length) {
        // A single Transaction rather than a list
        try {
            const tx = proto.Transaction.decode(bytes);
            list = [tx];
        } catch (error) {
            return { error: "could not decode: " + error.message };
        }
    }
    return {
        totalBytes: bytes.length,
        copies: list.length,
        copiesDetail: list.map((entry) => {
            try {
                const signed = proto.SignedTransaction.decode(entry.signedTransactionBytes);
                const body = proto.TransactionBody.decode(signed.bodyBytes);
                const id = body.transactionID;
                return {
                    node: body.nodeAccountID ? `${body.nodeAccountID.shardNum}.${body.nodeAccountID.realmNum}.${body.nodeAccountID.accountNum}` : null,
                    transactionIdAccount: id && id.accountID ? `${id.accountID.shardNum}.${id.accountID.realmNum}.${id.accountID.accountNum}` : null,
                    validStartSeconds: id && id.transactionValidStart ? String(id.transactionValidStart.seconds) : null,
                    validDurationSeconds: body.transactionValidDuration ? String(body.transactionValidDuration.seconds) : null,
                    memo: body.memo,
                    bodyBytesLength: signed.bodyBytes.length,
                    bodyBytesHashPrefix: require("node:crypto").createHash("sha256").update(signed.bodyBytes).digest("hex").slice(0, 12),
                    signatures: ((signed.sigMap && signed.sigMap.sigPair) || []).map((pair) => {
                        const type = pair.ed25519 && pair.ed25519.length ? "ed25519" : pair.ECDSASecp256k1 && pair.ECDSASecp256k1.length ? "ecdsa_secp256k1" : "other";
                        const sig = pair.ed25519 && pair.ed25519.length ? pair.ed25519 : pair.ECDSASecp256k1 || [];
                        return {
                            type,
                            pubKeyPrefixLength: pair.pubKeyPrefix ? pair.pubKeyPrefix.length : 0,
                            pubKeyPrefixHex: pair.pubKeyPrefix ? Buffer.from(pair.pubKeyPrefix).toString("hex").slice(0, 70) : "",
                            signatureLength: sig.length,
                        };
                    }),
                };
            } catch (error) {
                return { error: error.message };
            }
        }),
    };
}

/** Saves the rejected payment next to the database so it can be examined offline. It has no private key in it. */
function saveRejectedPayment(dir, paymentId, payload) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, paymentId + ".json"), JSON.stringify(payload, null, 2));
        return path.join(dir, paymentId + ".json");
    } catch {
        return null;
    }
}

module.exports = { describeSignedTransaction, saveRejectedPayment };
