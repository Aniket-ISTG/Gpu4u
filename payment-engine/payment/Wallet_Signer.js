"use strict";

const {
    Client,
    PrivateKey,
    TransferTransaction,
    Hbar,
    AccountId,
    TransactionId
} = require("@hiero-ledger/sdk");

const MIRROR_NODE_TESTNET_URL = "https://testnet.mirrornode.hedera.com";

/**
 * Resolves an address or Hedera Account ID against Hedera Testnet Mirror Node.
 * Converts EVM addresses to native Hedera account IDs (e.g. 0x667f... -> 0.0.11329382).
 * Verifies key type, balance, and rejects EVM-only unregistered addresses.
 */
async function resolveNativeHederaAccount(identifier, expectedNetwork = "testnet") {
    if (!identifier || typeof identifier !== "string") {
        throw new Error("Account identifier must be a non-empty string");
    }

    const cleanId = identifier.trim();

    // Verify network parameter
    const validTestnets = ["testnet", "hedera:testnet"];
    if (!validTestnets.includes(expectedNetwork.toLowerCase())) {
        throw new Error(`Network mismatch: expected Hedera Testnet but received '${expectedNetwork}'`);
    }

    const url = `${MIRROR_NODE_TESTNET_URL}/api/v1/accounts/${cleanId}`;

    let res;
    try {
        res = await fetch(url);
    } catch (err) {
        throw new Error(`Failed to reach Hedera Testnet Mirror Node: ${err.message}`);
    }

    if (res.status === 404) {
        throw new Error(`Address '${cleanId}' is not registered on Hedera Testnet. EVM-only or invalid addresses cannot be used for native Hedera payments.`);
    }

    if (!res.ok) {
        throw new Error(`Mirror Node query failed with HTTP ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    if (!data.account || !/^0\.0\.\d+$/.test(data.account)) {
        throw new Error(`Unable to resolve native Hedera Account ID for '${cleanId}'`);
    }

    return {
        nativeAccountId: data.account,
        evmAddress: data.evm_address || cleanId,
        keyType: data.key ? data.key._type : "UNKNOWN",
        publicKey: data.key ? data.key.key : null,
        balanceTinybars: data.balance ? data.balance.balance : 0,
        balanceHbar: data.balance ? data.balance.balance / 100_000_000 : 0,
        network: "hedera:testnet",
        isNative: true
    };
}

/**
 * Constructs and freezes a native Hedera TransferTransaction.
 * Serializes the transaction to Base64-encoded protobuf bytes for WalletConnect / HashPack.
 */
function buildTransferTransaction({
    senderAccountId,
    receiverAccountId,
    amountHbar,
    memo = "GPU Router x402 Payment",
    client = null
}) {
    if (!senderAccountId || !receiverAccountId || typeof amountHbar !== "number" || amountHbar <= 0) {
        throw new Error("Invalid parameters for TransferTransaction construction");
    }

    // Whole tinybars avoid the rounding errors floating point HBAR can introduce.
    const tinybars = BigInt(Math.round(amountHbar * 100_000_000));
    const activeClient = client || Client.forTestnet();
    const shouldCloseClient = !client;

    try {
        const tx = new TransferTransaction()
            .setTransactionId(TransactionId.generate(senderAccountId))
            .setNodeAccountIds([new AccountId(3)]) // Default consensus node
            .addHbarTransfer(senderAccountId, Hbar.fromTinybars(String(-tinybars)))
            .addHbarTransfer(receiverAccountId, Hbar.fromTinybars(String(tinybars)))
            .setTransactionMemo(memo)
            .freezeWith(activeClient);

        const bytes = tx.toBytes();
        const base64Transaction = Buffer.from(bytes).toString("base64");

        return {
            transaction: tx,
            transactionId: tx.transactionId.toString(),
            bytes,
            base64Transaction
        };
    } finally {
        if (shouldCloseClient) {
            activeClient.close();
        }
    }
}

/**
 * Deserializes a transaction from Base64 or Uint8Array bytes.
 */
function deserializeTransaction(txData) {
    const bytes = typeof txData === "string" ? Buffer.from(txData, "base64") : txData;
    return TransferTransaction.fromBytes(bytes);
}

/**
 * Signs and submits a transaction using an operator private key (used for backend testnet testing).
 * Keeps private key usage strictly separate from connected user wallet authorizations.
 */
async function signAndExecuteWithOperatorKey({
    transactionOrBytes,
    operatorAccountId,
    operatorPrivateKeyDer
}) {
    if (!operatorAccountId || !operatorPrivateKeyDer) {
        throw new Error("Operator credentials required for direct signing execution");
    }

    const client = Client.forTestnet();
    try {
        const key = PrivateKey.fromStringDer(operatorPrivateKeyDer.trim());
        client.setOperator(operatorAccountId, key);

        let tx;
        if (typeof transactionOrBytes === "string" || Buffer.isBuffer(transactionOrBytes) || transactionOrBytes instanceof Uint8Array) {
            tx = deserializeTransaction(transactionOrBytes);
        } else {
            tx = transactionOrBytes;
        }

        console.log(`[WALLET_SIGNER] Signing and submitting transaction on Hedera Testnet for operator ${operatorAccountId}...`);
        const response = await tx.execute(client);
        const receipt = await response.getReceipt(client);
        const status = receipt.status.toString();
        const txId = response.transactionId.toString();

        if (status !== "SUCCESS") {
            throw new Error(`Transaction failed on-chain: ${status}`);
        }

        return {
            success: true,
            status,
            transactionId: txId,
            receipt
        };
    } finally {
        client.close();
    }
}

module.exports = {
    resolveNativeHederaAccount,
    buildTransferTransaction,
    deserializeTransaction,
    signAndExecuteWithOperatorKey
};

