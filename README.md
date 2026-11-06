# GPU4U

Describe a GPU task in plain language. GPU4U finds the best live GPU for it, prices the job, and an AI agent pays for the lease with the x402 protocol on Hedera. The agent pays by itself under your spending limits and asks you first above them. Every payment is verified against the ledger and written to a tamper-evident audit log.

Status: Stage 0. GPU offers are real and live. The payment flow is real x402. Renting the GPU itself is simulated.

## How it works

```text
describe task -> connect wallet -> best GPU + price -> quote (USD to HBAR)
    -> spending policy -> [your approval] -> agent pays (x402) -> verified on the ledger
    -> lease -> lease time shown, payment final -> audit trail
```

| Part | What it does | Where |
| --- | --- | --- |
| Web app | Task input, GPU ranking, wallet, quote, approval and receipt screens | [frontend/](frontend/) |
| Payment service | Quotes, spending policy, approvals, the x402 agent and merchant, verification, audit | [payment-engine/](payment-engine/) |
| Marketplace | Live offers from the public Aquanode feed | [frontend/server/marketplace/](frontend/server/marketplace/) |

Read these for the detail:

- [docs/marketplace-and-routing.md](docs/marketplace-and-routing.md): the live marketplace, input validation, and how the best GPU is chosen
- [docs/x402-agent-workflow.md](docs/x402-agent-workflow.md): the end-to-end payment design and what was built
- [payment-engine/README.md](payment-engine/README.md): the payment service, its modes, API and safety properties

## Run it

You need Node 24 or newer. Open two terminals.

**1. Payment service**

```bash
cd payment-engine
cp .env.example .env     # set SERVICE_TOKEN to a long random string (16+ characters)
npm install
npm start                # http://127.0.0.1:4021, simulated mode, no credentials needed
```

**2. Web app**

```bash
cd frontend
cp .env.example .env.local
# set GROQ_API_KEY (task analysis)
# set PAYMENT_SERVICE_TOKEN to the same value as SERVICE_TOKEN above
npm install
npm run dev              # http://localhost:3000
```

Open http://localhost:3000, go to **Get Started**, connect a wallet from the navbar, describe a task, choose a GPU with **Rent**, and follow the payment.

With the default limits, the cheapest GPU for a small job pays by itself, and a larger job stops for your approval.

### Wallet

- **Real testnet:** the connected HashPack wallet signs every payment. Set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (free from https://cloud.reown.com). There is no manual account entry and no server-held payer key.
- **Simulated (development):** you may paste an account ID. It identifies you but cannot sign.

### Real payments on Hedera testnet

Set `PAYMENT_MODE=testnet` with a merchant account and a facilitator fee-payer account (see `payment-engine/.env.example`). Every confirmed payment and refund shows a HashScan and mirror node link. **The HashPack signing step has not been verified yet.** Follow [docs/testnet-manual-test.md](docs/testnet-manual-test.md) and report the results. Design and findings: [docs/testnet-wallet-payments.md](docs/testnet-wallet-payments.md).

## Tests

```bash
cd payment-engine && npm test     # 181 tests, no network, about 7 seconds
cd frontend && npm test           # 128 tests, no network, about 1 second
cd frontend && npx tsc --noEmit && npx eslint app components hooks lib server tests
```

## What is real and what is not

| Part | Status |
| --- | --- |
| GPU offers, prices, availability | Real, live from Aquanode |
| Task analysis and input validation | Real |
| Job duration and cost | Estimates from an assumed performance model, not benchmarks |
| x402 payment protocol | Real: HTTP 402, client signing, facilitator verify and settle |
| Settlement | Simulated ledger by default. Real Hedera testnet with `PAYMENT_MODE=testnet` |
| GPU rental and the "actual" usage | Simulated. No GPU is rented |
| Audit log | Hash-chained in the database. Anchored on Hedera Consensus Service in testnet mode |

Not yet verified in this repository: real testnet settlement (it needs credentials), signing with a real HashPack wallet, and the screens in a browser. The checks that could run without them all pass.
