"use strict";

const { HBAR, describe, formatAmount } = require("./asset");

const SINGLE_KEY_TYPES = ["ED25519", "ECDSA_SECP256K1"];

class WalletError extends Error {
    constructor(code, message, status = 422) {
        super(message);
        this.name = "WalletError";
        this.code = code;
        this.status = status;
    }
}

async function mirrorGet(fetchImpl, url) {
    let response;
    try {
        response = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
    } catch (error) {
        throw new WalletError("LEDGER_UNAVAILABLE", `Could not reach the Hedera testnet to check your account: ${error.message}`, 503);
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new WalletError("LEDGER_UNAVAILABLE", `The Hedera testnet answered HTTP ${response.status}`, 503);
    return response.json();
}

/**
 * Reads an account from the Hedera mirror node. For a token asset it also reads the account's balance of
 * that token, and whether the account is associated with it (an unassociated account cannot hold it).
 */
function mirrorWalletChecker({ mirrorUrl, fetchImpl = fetch }) {
    return {
        async inspect(accountId, asset = HBAR) {
            const body = await mirrorGet(fetchImpl, `${mirrorUrl}/api/v1/accounts/${accountId}`);
            if (!body) return { exists: false };
            const hbar = BigInt((body.balance && body.balance.balance) || 0);
            const info = {
                exists: true,
                keyType: body.key ? body.key._type : "UNKNOWN",
                balanceTinybars: hbar,
                balance: hbar,
                associated: true,
                receiverSigRequired: Boolean(body.receiver_sig_required),
            };
            if (asset.native) return info;

            const tokens = await mirrorGet(fetchImpl, `${mirrorUrl}/api/v1/accounts/${accountId}/tokens?token.id=${asset.id}`);
            const entry = ((tokens && tokens.tokens) || []).find((t) => t.token_id === asset.id);
            return { ...info, associated: Boolean(entry), balance: BigInt((entry && entry.balance) || 0) };
        },
    };
}

/** Reads an account from the simulated ledger. For development and tests only. */
function ledgerWalletChecker({ ledger }) {
    return {
        async inspect(accountId, asset = HBAR) {
            if (!ledger.hasAccount(accountId)) return { exists: false };
            return {
                exists: true,
                keyType: ledger.keyOf(accountId) ? "ECDSA_SECP256K1" : "NONE",
                balanceTinybars: ledger.balanceOf(accountId),
                balance: ledger.balanceOf(accountId, asset.id),
                associated: asset.native || ledger.isAssociated(accountId, asset.id),
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
async function assertWalletEligible(checker, accountId, tinybars, asset = HBAR) {
    const info = await checker.inspect(accountId, asset);
    if (!info.exists) throw new WalletError("WALLET_NOT_FOUND", `Account ${accountId} does not exist on the network this service uses`, 404);
    // Only a single ED25519 or ECDSA key can sign this payment. The mirror node reports key lists, thresholds
    // and anything else it cannot classify as ProtobufEncoded, and those must be refused.
    if (!SINGLE_KEY_TYPES.includes(info.keyType)) {
        throw new WalletError("UNSUPPORTED_KEY", `Account ${accountId} does not have a single key. Multi-signature accounts cannot sign this payment.`);
    }
    if (!asset.native && !info.associated) {
        throw new WalletError("TOKEN_NOT_ASSOCIATED", `Account ${accountId} is not associated with ${describe(asset)}. Associate the token in your wallet first, then get some from the testnet faucet.`);
    }
    const held = info.balance ?? info.balanceTinybars;
    if (held < BigInt(tinybars)) {
        // Shown in whole units (HBAR, USDC), which a person can read. Tinybars are not.
        const shown = (amount) => `${formatAmount(amount, asset)} ${asset.symbol}`;
        throw new WalletError(
            "INSUFFICIENT_BALANCE",
            `Account ${accountId} holds ${shown(held)}, less than the ${shown(tinybars)} this payment needs. Lower the spending cap, pick a cheaper GPU, or add funds from the testnet faucet.`,
        );
    }
    return info;
}

module.exports = { mirrorWalletChecker, ledgerWalletChecker, assertWalletEligible, WalletError };
