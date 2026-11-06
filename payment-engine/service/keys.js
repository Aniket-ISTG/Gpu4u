"use strict";

const { PrivateKey } = require("@hiero-ledger/sdk");

/** Accepts a DER-encoded key (what Hedera portals export) or a raw hex key. */
function parsePrivateKey(text) {
    const value = String(text || "").trim();
    if (!value) throw new Error("Private key is empty");
    try {
        return PrivateKey.fromStringDer(value);
    } catch {
        return PrivateKey.fromString(value);
    }
}

module.exports = { parsePrivateKey };
