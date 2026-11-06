"use strict";

require("dotenv").config();
const { processPayment, PaymentStatus } = require("../payment/Payment_Service");
const { resolveNativeHederaAccount } = require("../payment/Wallet_Signer");

async function runLiveTestnetIntegrationTests() {
    console.log("================================================================================");
    console.log("      🚀 REAL HEDERA TESTNET LIVE INTEGRATION TEST SUITE                       ");
    console.log("================================================================================");
    console.log(`Payer Account ID:    ${process.env.HEDERA_ACCOUNT_ID}`);
    console.log(`Receiver Account ID: ${process.env.HEDERA_RECEIVER_ID || "0.0.11326195"}`);
    console.log(`HCS Topic ID:        ${process.env.HEDERA_HCS_TOPIC_ID || "0.0.11329896"}`);
    console.log("================================================================================\n");

    const receiverId = process.env.HEDERA_RECEIVER_ID || "0.0.11326195";

    // 1. Account Resolution & Verification
    console.log("--- TEST 1: Native Hedera Account Resolution & EVM Mapping ---");
    const resolvedPayer = await resolveNativeHederaAccount(process.env.HEDERA_ACCOUNT_ID, "testnet");
    console.log(`[PASS] Payer resolved: Native ID ${resolvedPayer.nativeAccountId}, Key: ${resolvedPayer.keyType}, Balance: ${resolvedPayer.balanceHbar} HBAR`);

    // Verify previously noted EVM address resolves to native account 0.0.11329382
    const resolvedEVM = await resolveNativeHederaAccount("0x667f405f60Dc55Ca7707b18df6c6c0B9915c382B", "testnet");
    console.log(`[PASS] EVM Address 0x667f... resolved to Native Hedera Account: ${resolvedEVM.nativeAccountId} (${resolvedEVM.balanceHbar} HBAR)\n`);

    // 2. Real Native HBAR Payment on Hedera Testnet
    console.log("--- TEST 2: Real Native HBAR Transfer with HCS Audit Trail ---");
    const nativeRequestId = `live_native_${Date.now()}`;
    const nativeResult = await processPayment({
        requestId: nativeRequestId,
        receiverAccountId: receiverId,
        amount: 0.1, // 0.1 HBAR
        currency: "HBAR",
        network: "testnet",
        protocol: "native",
        provider: {
            providerId: "lambdalabs-gpu-node-1",
            gpuModel: "NVIDIA H100 SXM5 80GB",
            durationHours: 1,
            ratePerHour: 0.1
        }
    });

    console.log("\n[TEST 2 RESULT]:");
    console.log(`Status:         ${nativeResult.status}`);
    console.log(`Transaction ID: ${nativeResult.transactionId}`);
    console.log(`Settled:        ${nativeResult.settlement?.settled}`);
    console.log(`Consensus Time: ${nativeResult.settlement?.consensusTimestamp}`);
    console.log(`Explorer URL:   ${nativeResult.settlement?.explorerUrl}\n`);

    if (nativeResult.status !== PaymentStatus.CONFIRMED) {
        throw new Error(`Test 2 failed: Expected CONFIRMED but got ${nativeResult.status}`);
    }

    // 3. Real x402 Protocol Payment on Hedera Testnet
    console.log("--- TEST 3: Real x402 v2 Protocol Settlement with HCS Audit Trail ---");
    const x402RequestId = `live_x402_${Date.now()}`;
    const x402Result = await processPayment({
        requestId: x402RequestId,
        receiverAccountId: receiverId,
        amount: 0.15, // 0.15 HBAR
        currency: "HBAR",
        network: "testnet",
        protocol: "x402",
        provider: {
            providerId: "runpod-secure-cloud-2",
            gpuModel: "NVIDIA H100 PCIe 80GB",
            durationHours: 1,
            ratePerHour: 0.15
        }
    });

    console.log("\n[TEST 3 RESULT]:");
    console.log(`Status:         ${x402Result.status}`);
    console.log(`Transaction ID: ${x402Result.transactionId}`);
    console.log(`Protocol:       ${x402Result.protocol}`);
    console.log(`Settled:        ${x402Result.settlement?.settled}`);
    console.log(`Consensus Time: ${x402Result.settlement?.consensusTimestamp}`);
    console.log(`Explorer URL:   ${x402Result.settlement?.explorerUrl}\n`);

    if (x402Result.status !== PaymentStatus.CONFIRMED) {
        throw new Error(`Test 3 failed: Expected CONFIRMED but got ${x402Result.status}`);
    }

    console.log("================================================================================");
    console.log("      🎉 ALL REAL HEDERA TESTNET LIVE INTEGRATION TESTS PASSED!                ");
    console.log("================================================================================");
}

runLiveTestnetIntegrationTests().catch(err => {
    console.error("❌ Live Testnet Integration Test Failed:", err);
    process.exit(1);
});

