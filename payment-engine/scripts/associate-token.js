"use strict";

/**
 * Associates an account with the payment token (USDC), which Hedera requires before the account can
 * receive or hold it. The Hedera portal has no button for this.
 *
 *   ASSOCIATE_ACCOUNT_ID=0.0.1234 ASSOCIATE_ACCOUNT_KEY=3030... npm run associate
 *
 * Run it once for the merchant (HEDERA_RECEIVER_ID), and once for any test payer account you control that
 * is not a wallet. A HashPack account associates the token inside the wallet instead. The account's own
 * key must sign, so this is the one place the merchant's key is needed. Nothing is stored or logged.
 *
 * Uses USDC_TOKEN_ID (default: Circle's testnet USDC, 0.0.429274). Testnet only.
 */

require("dotenv").config();
const { Client, AccountId, TokenId, TokenAssociateTransaction } = require("@hiero-ledger/sdk");
const { parsePrivateKey } = require("../service/keys");
const { TESTNET_USDC_ID } = require("../service/asset");

async function main() {
    const accountId = process.env.ASSOCIATE_ACCOUNT_ID;
    const keyText = process.env.ASSOCIATE_ACCOUNT_KEY;
    const tokenId = process.env.USDC_TOKEN_ID || TESTNET_USDC_ID;
    if (!accountId || !keyText) throw new Error("Set ASSOCIATE_ACCOUNT_ID and ASSOCIATE_ACCOUNT_KEY (the account's own key).");
    if (!/^0\.0\.\d+$/.test(accountId) || !/^0\.0\.\d+$/.test(tokenId)) throw new Error("Account and token IDs must look like 0.0.1234.");
    if (/mainnet/i.test(process.env.HEDERA_NETWORK || "")) throw new Error("This script only works on Hedera testnet.");

    const key = parsePrivateKey(keyText);
    const client = Client.forTestnet().setOperator(AccountId.fromString(accountId), key);
    try {
        const response = await new TokenAssociateTransaction()
            .setAccountId(AccountId.fromString(accountId))
            .setTokenIds([TokenId.fromString(tokenId)])
            .execute(client);
        const receipt = await response.getReceipt(client);
        console.log(`Associated ${accountId} with ${tokenId}: ${receipt.status.toString()}`);
        console.log(`Transaction: https://hashscan.io/testnet/transaction/${response.transactionId.toString()}`);
    } finally {
        client.close();
    }
}

main().catch((error) => {
    // An account that is already associated is fine.
    if (/TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT/.test(error.message)) {
        console.log("Already associated. Nothing to do.");
        return;
    }
    console.error("associate failed: " + error.message);
    process.exit(1);
});
