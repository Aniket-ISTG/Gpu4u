"use strict";

const { PublicKey } = require("@hiero-ledger/sdk");
const { proto } = require("@hiero-ledger/proto");

/** Wallets sign messages with this prefix, so a signed message can never double as a transaction. */
function prefixMessage(message) {
    return Buffer.from(`\x19Hedera Signed Message:\n${message.length}${message}`);
}

/** Decodes the base64 SignatureMap that Hedera wallets return from signMessage. */
function signaturesFromMap(signatureMapBase64) {
    const map = proto.SignatureMap.decode(Buffer.from(signatureMapBase64, "base64"));
    return map.sigPair
        .map((pair) => (pair.ed25519 && pair.ed25519.length ? pair.ed25519 : pair.ECDSASecp256k1))
        .filter((sig) => sig && sig.length);
}

/**
 * Verifies a wallet signature over an approval message.
 * Accepts either a wallet SignatureMap (base64) or a bare signature (hex or base64).
 */
function verifyWalletSignature({ message, signatureMap, signature, publicKey }) {
    const bytes = prefixMessage(message);
    const candidates = [];
    if (signatureMap) candidates.push(...signaturesFromMap(signatureMap));
    if (signature) {
        const text = String(signature).trim();
        candidates.push(/^[0-9a-fA-F]+$/.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64"));
    }
    return candidates.some((sig) => {
        try {
            return publicKey.verify(bytes, sig);
        } catch {
            return false;
        }
    });
}

/** Looks up an account's public key on the mirror node. */
function mirrorPublicKeyResolver(mirrorUrl, fetchImpl = fetch) {
    return async (accountId) => {
        const response = await fetchImpl(`${mirrorUrl}/api/v1/accounts/${accountId}`, { signal: AbortSignal.timeout(8000) });
        if (response.status === 404) throw new Error(`Account ${accountId} does not exist on the network`);
        if (!response.ok) throw new Error(`Mirror node returned HTTP ${response.status}`);
        const body = await response.json();
        const key = body.key;
        if (!key || !key.key) throw new Error(`Account ${accountId} has no single public key (multi-signature accounts are not supported)`);
        if (key._type === "ED25519") return PublicKey.fromStringED25519(key.key);
        if (key._type === "ECDSA_SECP256K1") return PublicKey.fromStringECDSA(key.key);
        throw new Error(`Unsupported key type ${key._type}`);
    };
}

module.exports = { prefixMessage, verifyWalletSignature, mirrorPublicKeyResolver, signaturesFromMap };
