"use strict";

/**
 * Creates the agent's own Hedera testnet account and funds it, so the agent can pay with its own key and
 * no human has to sign. The new key is written to payment-engine/.env.agent (git-ignored) and is never printed.
 *
 *   npm run agent:create            funds the agent with 20 HBAR
 *   AGENT_FUND_HBAR=50 npm run agent:create
 *
 * The funds come from the merchant account (HEDERA_MERCHANT_PRIVATE_KEY) when its key is set, otherwise from the
 * facilitator fee payer. Testnet only: this script refuses to run against anything else. It will not overwrite
 * an existing .env.agent.
 */

require("dotenv").config({ quiet: true });
const fs = require("node:fs");
const path = require("node:path");
const { Client, AccountId, AccountCreateTransaction, Hbar, PrivateKey } = require("@hiero-ledger/sdk");
const { parsePrivateKey } = require("../service/keys");

const TARGET = path.resolve(__dirname, "../.env.agent");

async function main() {
    if (/mainnet/i.test(process.env.HEDERA_NETWORK || "")) throw new Error("This script only works on Hedera testnet.");
    if (fs.existsSync(TARGET)) throw new Error(`${TARGET} already exists. Delete it yourself if you want a new agent account.`);

    const amount = Number(process.env.AGENT_FUND_HBAR || 20);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000) throw new Error("AGENT_FUND_HBAR must be between 0 and 1000.");

    const funder = process.env.HEDERA_MERCHANT_PRIVATE_KEY && process.env.HEDERA_RECEIVER_ID
        ? { id: process.env.HEDERA_RECEIVER_ID, key: process.env.HEDERA_MERCHANT_PRIVATE_KEY, label: "merchant" }
        : { id: process.env.FACILITATOR_FEE_PAYER_ID, key: process.env.FACILITATOR_FEE_PAYER_KEY, label: "facilitator fee payer" };
    if (!funder.id || !funder.key) throw new Error("Set HEDERA_RECEIVER_ID and HEDERA_MERCHANT_PRIVATE_KEY (or the fee payer's ID and key) in .env to fund the agent.");

    const agentKey = PrivateKey.generateECDSA();
    const client = Client.forTestnet().setOperator(AccountId.fromString(funder.id), parsePrivateKey(funder.key));
    try {
        const response = await new AccountCreateTransaction()
            .setKeyWithoutAlias(agentKey.publicKey)
            .setInitialBalance(new Hbar(amount))
            .setAccountMemo("GPU4U agent")
            .execute(client);
        const receipt = await response.getReceipt(client);
        const agentId = receipt.accountId.toString();

        fs.writeFileSync(
            TARGET,
            `# The GPU4U agent's own testnet account. Never commit this file.\nAGENT_ACCOUNT_ID=${agentId}\nAGENT_PRIVATE_KEY=${agentKey.toStringDer()}\n`,
            { mode: 0o600 },
        );
        console.log(`Created agent account ${agentId} with ${amount} HBAR from the ${funder.label} (${funder.id}).`);
        console.log(`Account:     https://hashscan.io/testnet/account/${agentId}`);
        console.log(`Transaction: https://hashscan.io/testnet/transaction/${response.transactionId.toString()}`);
        console.log(`The key was saved to ${TARGET} (not printed). Run: npm run agent -- "your task"`);
    } finally {
        client.close();
    }
}

main().catch((error) => {
    console.error("agent:create failed: " + error.message);
    process.exit(1);
});
