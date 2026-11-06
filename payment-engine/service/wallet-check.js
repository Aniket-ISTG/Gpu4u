"use strict";

const SINGLE_KEY_TYPES = ["ED25519", "ECDSA_SECP256K1"];

class WalletError extends Error {
    constructor(code, message, status = 422) {
        super(message);
        this.name = "WalletError";
        this.code = code;
        this.status = status;
    }
}

/** Reads an account from the Hedera mirror node. */
function mirrorWalletChecker({ mirrorUrl, fetchImpl = fetch }) {
    return {
        async inspect(accountId) {
            let response;
            try {
                response = await fetchImpl(`${mirrorUrl}/api/v1/accounts/${accountId}`, { signal: AbortSignal.timeout(10000) });
            } catch (error) {
                throw new WalletError("LEDGER_UNAVAILABLE", `Could not reach the Hedera testnet to check your account: ${error.message}`, 503);
            }
            if (response.status === 404) return { exists: false };
            if (!response.ok) throw new WalletError("LEDGER_UNAVAILABLE", `The Hedera testnet answered HTTP ${response.status}`, 503);
            const body = await response.json();
            return {
                exists: true,
                keyType: body.key ? body.key._type : "UNKNOWN",
                balanceTinybars: BigInt((body.balance && body.balance.balance) || 0),
                receiverSigRequired: Boolean(body.receiver_sig_required),
            };
        },
    };
}

/** Reads an account from the simulated ledger. For development and tests only. */
function ledgerWalletChecker({ ledger }) {
    return {
        async inspect(accountId) {
            if (!ledger.hasAccount(accountId)) return { exists: false };
            return {
                exists: true,
                keyType: ledger.keyOf(accountId) ? "ECDSA_SECP256K1" : "NONE",
                balanceTinybars: ledger.balanceOf(accountId),
                receiverSigRequired: false,
            };
        },
    };
}

/**
 * Refuses a quote the wallet could never complete: an account that does not exist,
 * one without a single key to sign with, or one that cannot cover the payment.
 * Failing here is kinder than failing after the user has clicked through a wallet prompt.
 */
async function assertWalletEligible(checker, accountId, tinybars) {
    const info = await checker.inspect(accountId);
    if (!info.exists) throw new WalletError("WALLET_NOT_FOUND", `Account ${accountId} does not exist on the network this service uses`, 404);
    // Only a single ED25519 or ECDSA key can sign this payment. The mirror node reports key lists, thresholds
    // and anything else it cannot classify as ProtobufEncoded, and those must be refused.
    if (!SINGLE_KEY_TYPES.includes(info.keyType)) {
        throw new WalletError("UNSUPPORTED_KEY", `Account ${accountId} does not have a single key. Multi-signature accounts cannot sign this payment.`);
    }
    if (info.balanceTinybars < BigInt(tinybars)) {
        throw new WalletError("INSUFFICIENT_BALANCE", `Account ${accountId} holds ${info.balanceTinybars} tinybars, less than the ${tinybars} needed`);
    }
    return info;
}

module.exports = { mirrorWalletChecker, ledgerWalletChecker, assertWalletEligible, WalletError };
