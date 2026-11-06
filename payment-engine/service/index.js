"use strict";

require("dotenv").config();
const { loadConfig, assertRunnable } = require("./config");
const { buildServices } = require("./container");
const { createApp, startServer } = require("./app");
const { runPreflight } = require("./preflight");

const SWEEP_INTERVAL_MS = 5000;
const CONFIRM_INTERVAL_MS = 30_000;

async function main() {
    const config = loadConfig();
    assertRunnable(config);

    const services = await buildServices(config);

    // Real testnet mode checks everything it depends on first, and stops on any problem. It never
    // continues with something simulated.
    let preflight = [];
    if (!config.simulated) preflight = await runPreflight({ config, services });

    const app = createApp(services);
    const { server, baseUrl } = await startServer(app, services, config.port);

    const interrupted = services.payments.recover();
    const sweep = setInterval(() => {
        services.payments.sweepExpired();
        services.payments.sweepLeases().catch((error) => console.error("[service] lease sweep failed: " + error.message));
    }, SWEEP_INTERVAL_MS);
    sweep.unref();
    if (services.publisher) {
        const confirm = setInterval(() => {
            services.publisher.confirmPending().catch((error) => console.error("[service] audit confirmation failed: " + error.message));
        }, CONFIRM_INTERVAL_MS);
        confirm.unref();
    }

    const line = "=".repeat(78);
    console.log(line);
    console.log(" GPU4U payment service");
    console.log(line);
    console.log(" Listening:       " + baseUrl);
    console.log(" Mode:            " + config.mode.toUpperCase());
    console.log(" Payer:           " + (config.payer.mode === "wallet" ? "the user's wallet signs every payment" : "a server-held agent key (simulated development only)"));
    if (services.accounts.agent) console.log(" Agent account:   " + services.accounts.agent);
    console.log(" Merchant:        " + services.accounts.merchant);
    console.log(" Facilitator:     " + (config.facilitator.mode === "local" ? "local (fee payer " + services.accounts.feePayer + ")" : config.facilitator.url));
    console.log(" Approval mode:   " + config.approval.mode);
    console.log(" Limits (USD):    auto " + config.policy.autoApproveLimitUsd + " | daily " + config.policy.dailyLimitUsd +
        " | ceiling " + config.policy.hardCeilingUsd + " | service-wide " + config.policy.globalDailyLimitUsd);
    if (interrupted) console.log(" Recovered:       " + interrupted + " item(s) interrupted by the last shutdown were marked failed or owed");
    for (const entry of preflight) console.log(" " + entry);
    console.log(line);
    if (config.simulated) {
        console.log(" SIMULATED MODE: payments settle on an in-memory ledger. NOTHING is sent to Hedera,");
        console.log(" so there is no transaction on HashScan. Use PAYMENT_MODE=testnet for real settlement.");
    } else {
        console.log(" HEDERA TESTNET: payments are real transactions on the testnet.");
        console.log(" Every payment is signed by the user's own wallet. There is no server-held payer.");
        if (config.approval.mode === "click") console.log(" Approvals are by click, then the wallet signs. Set APPROVAL_MODE=wallet to also require a signed approval.");
    }
    console.log(line);

    let closing = false;
    const shutdown = async (signal) => {
        if (closing) return;
        closing = true;
        console.log("\n[service] " + signal + " received, finishing in-flight payments");
        server.close();
        await services.close();
        process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
    console.error("[service] could not start: " + error.message);
    process.exit(1);
});
