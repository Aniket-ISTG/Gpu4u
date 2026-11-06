"use strict";

require("dotenv").config();
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { processPayment } = require("./payment/Payment_Service");
const { resolveNativeHederaAccount } = require("./payment/Wallet_Signer");

async function main() {
    console.log("================================================================================");
    console.log("             🤖 GPU ROUTER PAYMENT & APPROVAL ENGINE (x402 / HEDERA)            ");
    console.log("================================================================================");
    console.log(`Hedera Network:   ${process.env.HEDERA_NETWORK || "testnet"}`);
    console.log(`Operator Account: ${process.env.HEDERA_ACCOUNT_ID}`);
    console.log(`Receiver Account: ${process.env.HEDERA_RECEIVER_ID || "0.0.11326195"}`);
    console.log(`HCS Audit Topic:  ${process.env.HEDERA_HCS_TOPIC_ID || "0.0.11329896"}`);
    console.log("================================================================================\n");

    const rl = readline.createInterface({ input: stdin, output: stdout });

    try {
        console.log("Select a terminal payment scenario to execute:");
        console.log("  1) Autonomous GPU Payment (2 HBAR - Within 5 HBAR limit)");
        console.log("  2) High-Value GPU Lease (6 HBAR - Triggers Interactive Human Approval)");
        console.log("  3) Official x402 v2 Protocol Payment (0.15 HBAR on Hedera Testnet)");
        console.log("  4) Resolve Connected Wallet / ECDSA EVM Address");
        console.log("  5) Exit\n");

        const choice = (await rl.question("Enter choice (1-5): ")).trim();

        const receiverId = process.env.HEDERA_RECEIVER_ID || "0.0.11326195";

        if (choice === "1") {
            console.log("\n▶ Executing Autonomous Micro-Payment for GPU Compute (Within 5 HBAR Limit)...");
            const result = await processPayment({
                requestId: `req_auto_${Date.now()}`,
                receiverAccountId: receiverId,
                amount: 2,
                currency: "HBAR",
                protocol: "native",
                provider: {
                    providerId: "runpod-community-node-4",
                    gpuModel: "NVIDIA RTX 4090 24GB",
                    durationHours: 1,
                    ratePerHour: 2
                }
            });
            displayResult(result);

        } else if (choice === "2") {
            console.log("\n▶ Executing High-Value GPU Lease (6 HBAR - Requires Operator Terminal Approval)...");
            const result = await processPayment({
                requestId: `req_high_${Date.now()}`,
                receiverAccountId: receiverId,
                amount: 6,
                currency: "HBAR",
                protocol: "native",
                provider: {
                    providerId: "lambdalabs-enterprise-cluster",
                    gpuModel: "NVIDIA H100 SXM5 80GB",
                    durationHours: 1,
                    ratePerHour: 6
                }
            });
            displayResult(result);

        } else if (choice === "3") {
            console.log("\n▶ Executing Official x402 v2 Protocol Lease Payment...");
            const result = await processPayment({
                requestId: `req_x402_${Date.now()}`,
                receiverAccountId: receiverId,
                amount: 0.15,
                currency: "HBAR",
                protocol: "x402",
                provider: {
                    providerId: "tensordock-gpu-core",
                    gpuModel: "NVIDIA A100 SXM4 80GB",
                    durationHours: 1,
                    ratePerHour: 0.15
                }
            });
            displayResult(result);

        } else if (choice === "4") {
            const addressInput = (await rl.question("Enter Hedera Account ID or EVM Address (press Enter for default EVM 0x667f...): ")).trim();
            const target = addressInput || "0x667f405f60Dc55Ca7707b18df6c6c0B9915c382B";
            console.log(`\nResolving '${target}' against Hedera Testnet Mirror Node...`);
            const resolved = await resolveNativeHederaAccount(target, "testnet");
            console.log("\n--- ACCOUNT RESOLUTION DETAILS ---");
            console.log(`Native Account ID:  ${resolved.nativeAccountId}`);
            console.log(`EVM Address:        ${resolved.evmAddress}`);
            console.log(`Key Algorithm:      ${resolved.keyType}`);
            console.log(`Balance:            ${resolved.balanceHbar} HBAR (${resolved.balanceTinybars} tinybars)`);
            console.log(`Network Verified:   ${resolved.network}`);

        } else {
            console.log("Exiting.");
        }

    } catch (err) {
        console.error("\n❌ Execution Error:", err.message);
    } finally {
        rl.close();
    }
}

function displayResult(result) {
    console.log("\n================================================================================");
    console.log("                         🏁 FINAL PAYMENT RESULT                                ");
    console.log("================================================================================");
    console.log(`Status:         ${result.status} ${result.success ? "✅" : "❌"}`);
    console.log(`Payment ID:     ${result.paymentId}`);
    console.log(`Request ID:     ${result.requestId}`);
    console.log(`Protocol:       ${(result.protocol || "native").toUpperCase()}`);
    console.log(`Amount:         ${result.amount} ${result.currency}`);
    console.log(`Receiver:       ${result.receiverAccountId}`);
    if (result.transactionId) {
        console.log(`Transaction ID: ${result.transactionId}`);
    }
    if (result.settlement?.explorerUrl) {
        console.log(`HashScan URL:   ${result.settlement.explorerUrl}`);
    }
    if (result.error) {
        console.log(`Error Reason:   ${result.error}`);
    }
    console.log("================================================================================\n");
}

if (require.main === module) {
    main();
}

module.exports = { main };
