"use strict";

/**
 * Runs the whole GPU4U app as one unit: the payment service (private, on 127.0.0.1) and the
 * Next.js web app (public, on $PORT). If either one stops, this stops too, so the host restarts it.
 *
 *   npm start
 */

const { spawn } = require("node:child_process");
const path = require("node:path");

const root = __dirname;
const webPort = process.env.PORT || "3000";
const paymentPort = process.env.PAYMENT_PORT || "4021";

// The web app and the payment service share one secret. Set it once, as either name.
const token = process.env.SERVICE_TOKEN || process.env.PAYMENT_SERVICE_TOKEN;
if (!token || token.length < 16) {
  console.error("[start] Set SERVICE_TOKEN to a random string of at least 16 characters (for example: openssl rand -hex 24).");
  process.exit(1);
}

const sharedEnv = {
  ...process.env,
  SERVICE_TOKEN: token,
  PAYMENT_SERVICE_TOKEN: token,
};

if (!sharedEnv.DB_PATH) {
  sharedEnv.DB_PATH = ":memory:";
  console.log("[start] DB_PATH not set: using an in-memory store. Payment history is lost on restart.");
}

const children = [];
let stopping = false;

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 5000).unref();
}

function run(name, command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, stdio: "inherit" });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`[start] ${name} stopped (${signal || "exit " + code}). Shutting down.`);
    stopAll(code || 1);
  });
  return child;
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stopping) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function main() {
  // 1. Payment service first. In testnet mode it checks Hedera before it starts listening.
  run(
    "payment service",
    process.execPath,
    [path.join(root, "payment-engine", "service", "index.js")],
    path.join(root, "payment-engine"),
    { ...sharedEnv, PORT: paymentPort },
  );

  const healthy = await waitForHealth(`http://127.0.0.1:${paymentPort}/v1/health`, 90_000);
  if (!healthy) {
    console.error("[start] The payment service did not become healthy within 90 seconds.");
    stopAll(1);
    return;
  }

  // 2. Then the web app, pointed at the payment service on localhost.
  run(
    "web app",
    process.execPath,
    [path.join(root, "frontend", "node_modules", "next", "dist", "bin", "next"), "start", "-p", webPort],
    path.join(root, "frontend"),
    { ...sharedEnv, PAYMENT_SERVICE_URL: `http://127.0.0.1:${paymentPort}` },
  );
}

process.on("SIGTERM", () => stopAll(0));
process.on("SIGINT", () => stopAll(0));

main().catch((error) => {
  console.error("[start] " + error.message);
  stopAll(1);
});
