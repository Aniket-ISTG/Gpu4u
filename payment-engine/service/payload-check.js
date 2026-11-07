"use strict";

const { inspectHederaTransaction } = require("@x402/hedera");
const { HBAR } = require("./asset");

const MAX_TRANSACTION_BASE64_LENGTH = 20_000;

/**
 * Checks the payment a wallet signed, before it is relayed to the facilitator. The facilitator checks
 * the signature against the payer's on-chain key. This check makes sure the payment is the one this
 * quote asked for: the same terms the server advertised, and a transfer of exactly the quoted amount
 * from the quote's own wallet to the merchant, and nothing else.
 *
 * Returns { problems, transactionId }. An empty problems list means it is safe to relay.
 */
function checkWalletPayload({ payload, required, quote, knownFeePayers }) {
    const problems = [];
    if (!payload || typeof payload !== "object") return { problems: ["The payment is missing"], transactionId: null };

    if (payload.x402Version !== 2) problems.push("Unsupported x402 version " + payload.x402Version);

    const accepted = payload.accepted || {};
    const wanted = (required && required.accepts && required.accepts[0]) || {};
    const same = (key) => String(accepted[key]) === String(wanted[key]);
    for (const key of ["scheme", "network", "amount", "asset", "payTo", "maxTimeoutSeconds"]) {
        if (!same(key)) problems.push(`The signed terms differ from the server's on ${key}`);
    }
    if ((accepted.extra && accepted.extra.feePayer) !== (wanted.extra && wanted.extra.feePayer)) {
        problems.push("The signed terms name a different fee payer than the server's");
    }
    const asset = quote.asset || HBAR;
    if (accepted.asset !== asset.id) problems.push(`The signed asset is not the quoted ${asset.symbol}`);
    if (String(accepted.amount) !== String(quote.tinybars)) problems.push("The signed amount is not the quoted amount");
    if (accepted.payTo !== quote.payTo) problems.push("The signed recipient is not the quote's merchant");

    const transaction = payload.payload && payload.payload.transaction;
    if (typeof transaction !== "string" || !transaction || transaction.length > MAX_TRANSACTION_BASE64_LENGTH) {
        problems.push("The signed transaction is missing or too large");
        return { problems, transactionId: null };
    }

    let inspected;
    try {
        inspected = inspectHederaTransaction(transaction);
    } catch (error) {
        problems.push("The signed transaction could not be read: " + error.message);
        return { problems, transactionId: null };
    }

    if (inspected.transactionType !== "TransferTransaction") problems.push("The transaction is not a transfer");
    if (inspected.hasNonTransferOperations) problems.push("The transaction contains operations other than a transfer");
    if (!knownFeePayers.includes(inspected.transactionIdAccountId)) {
        problems.push(`The transaction's fee payer ${inspected.transactionIdAccountId} is not this service's facilitator`);
    }

    // Exactly two transfers of the quoted asset: the wallet pays the amount, the merchant receives it. The
    // fee is paid by the facilitator through the transaction ID, so nothing else may move.
    const expected = BigInt(quote.tinybars);
    let transfers;
    if (asset.native) {
        if (Object.keys(inspected.tokenTransfers || {}).length > 0) problems.push("The transaction moves tokens, which is not allowed");
        transfers = inspected.hbarTransfers || [];
    } else {
        if ((inspected.hbarTransfers || []).length > 0) problems.push("The transaction moves HBAR, which is not allowed for a token payment");
        const tokens = Object.keys(inspected.tokenTransfers || {});
        if (tokens.length !== 1 || tokens[0] !== asset.id) problems.push(`The transaction must move only ${asset.symbol} (${asset.id})`);
        transfers = (inspected.tokenTransfers || {})[asset.id] || [];
    }
    const byAccount = new Map(transfers.map((t) => [t.accountId, BigInt(t.amount)]));
    if (transfers.length !== 2 || byAccount.size !== 2) problems.push("The transfer must have exactly two parties");
    if (byAccount.get(quote.wallet) !== -expected) {
        problems.push(`The transfer must take exactly ${expected} ${asset.unit} from your wallet ${quote.wallet}`);
    }
    if (byAccount.get(quote.payTo) !== expected) {
        problems.push(`The transfer must give exactly ${expected} ${asset.unit} to the merchant ${quote.payTo}`);
    }

    return { problems, transactionId: inspected.transactionId || null };
}

module.exports = { checkWalletPayload };
