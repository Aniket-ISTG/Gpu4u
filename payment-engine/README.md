# GPU4U Payment Service (x402 on Hedera)

The payment half of GPU4U. An AI agent pays for a GPU lease through the x402 protocol on Hedera. Spending limits decide whether it may pay on its own, a person approves anything larger, an independent check confirms the money moved exactly as quoted, and every step is written to a hash-chained audit log that is anchored on the Hedera Consensus Service.

It is a separate Node service. The web app's server calls it with a secret token. The browser never talks to it, and no key ever reaches the browser.

The end-to-end design is in [../docs/x402-agent-workflow.md](../docs/x402-agent-workflow.md).

## Two modes

| | `simulated` (default) | `testnet` |
| --- | --- | --- |
| Credentials needed | None | A funded Hedera testnet account, plus a facilitator |
| Where money moves | An in-memory ledger | The real Hedera testnet |
| x402 protocol | Real: 402 response, client signing, facilitator verify and settle | Real |
| Facilitator checks | Real official verification code, simulated submission | Real |
| HashScan link | None | Yes |
| Audit anchoring | Local database only | Hedera Consensus Service topic |

Simulated mode exists so the whole flow can run and be tested without credentials. It runs the real x402 packages over real HTTP. Only the final step differs: the facilitator settles on a simulated ledger instead of submitting to Hedera. The service prints a banner and every receipt says so, so a simulated payment can never be mistaken for a real one.

## Quick start

```bash
cd payment-engine
cp .env.example .env        # set SERVICE_TOKEN to a long random string
npm install
npm start                   # listens on http://127.0.0.1:4021
```

Then start the web app (see the root README) with the same token as `PAYMENT_SERVICE_TOKEN`.

### Real settlement on Hedera testnet

In testnet the **user's connected wallet signs every payment**; the service never holds a payer key. A local facilitator (official x402 `exact` scheme, `hedera:testnet`) verifies the signed transfer, adds the fee-payer signature and submits it. The lease starts only after the transaction is confirmed on the mirror node. **There are no refunds**: the payment is final, and ending a lease just closes it. The lease time shown is not GPU utilization.

1. Create a receiver account and a separate fee-payer account at https://portal.hedera.com and fund the fee payer.
2. Set `PAYMENT_MODE=testnet`, `HEDERA_RECEIVER_ID` (no key needed), `FACILITATOR_FEE_PAYER_ID`, `FACILITATOR_FEE_PAYER_KEY`. Startup runs a preflight and refuses to start on any problem; it never falls back to simulated. Mainnet is refused.
3. `npm run live:check` runs one payment with a stand-in payer key (not HashPack).
4. Follow [../docs/testnet-manual-test.md](../docs/testnet-manual-test.md) for the real wallet test.

## Paying in HBAR or USDC

`PAYMENT_ASSET` chooses what a payment is made in. HBAR is the default.

| | `hbar` (default) | `usdc` |
| --- | --- | --- |
| Asset | Native HBAR (`0.0.0`) | HTS token `USDC_TOKEN_ID` (Circle testnet USDC `0.0.429274`, 6 decimals) |
| Amount | USD cap converted at the Hedera network rate, rounded up to a tinybar | The USD cap in token units. The token is worth $1, so there is no rate |
| Ledger check | Reads HBAR `transfers` | Reads `token_transfers` for that token. The payer must not have spent HBAR, and no other token or account may have been paid |
| User's wallet needs | HBAR | The token, associated with the account. No HBAR for the payment itself |
| Network fee | Paid by the facilitator fee payer, in HBAR | The same |

For USDC to work on testnet:

1. **Associate the token** with the receiver (`HEDERA_RECEIVER_ID`) and with the paying wallet. The service refuses to start if the receiver cannot receive it, and refuses a quote if the wallet is not associated or holds too little. For the receiver: `ASSOCIATE_ACCOUNT_ID=0.0.x ASSOCIATE_ACCOUNT_KEY=... npm run associate`. HashPack associates inside the wallet.
2. **Fund the wallet** with test USDC from https://faucet.circle.com (choose Hedera Testnet).
3. Set `PAYMENT_ASSET=usdc`. Startup checks that the token exists, is a fungible token, is not paused, and has 6 decimals, because the amounts would be wrong otherwise.

The amount field keeps its historical name `tinybars` in the API and database. For a token it holds token units. Every quote carries its `asset`, so an amount is never read in the wrong unit, and a quote made before tokens existed is read as HBAR. The agent and the wallet both refuse terms in an asset other than the one that was quoted and approved.

## How a payment works

```text
quote  ->  policy  ->  [approval]  ->  agent pays (x402)  ->  verify  ->  lease  ->  reconcile
```

1. **Quote.** The web app's server prices the chosen GPU and asks this service for a quote. The service converts the USD cap to HBAR at the Hedera network exchange rate, rounding up to a whole tinybar, and stores the quote with an expiry. The amount is fixed by the quote. Nothing the browser sends can change it.
2. **Policy.** The amount is compared with the spending rules (below). The result is `auto`, `approval` or `refuse`.
3. **Approval** (only for `approval`). The payment is held and saved. Nothing is paid. A person approves or rejects. In `wallet` mode approving needs a wallet signature over the exact terms.
4. **Agent pays.** The agent calls the lease endpoint. The server answers **402 Payment Required** with the exact price from the stored quote. Before signing, the agent checks the terms against the approved quote: same network, asset HBAR, same recipient, the exact amount, and a fee payer it trusts. It signs a transfer from the agent account, and the facilitator pays the network fee and submits it.
5. **Verify.** The service does not trust the facilitator's answer. It reads the transaction back from the ledger and checks that the merchant received exactly the quoted amount, the agent paid exactly that, nobody else received value, and the fee payer is a known facilitator.
6. **Lease.** Only after verification is a lease created. Stage 0 simulates the lease, because renting a real GPU needs an Aquanode account and its private API.
7. **End.** Ending the lease closes it. The payment is final and nothing is refunded.

### Payment states

`RECEIVED`, `POLICY_CHECKED`, `PENDING_APPROVAL`, `APPROVED`, `AWAITING_402`, `SIGNING`, `SUBMITTED`, `CONFIRMED`, `LEASE_ACTIVE`, `RECONCILED`, and the endings `REFUSED`, `REJECTED`, `EXPIRED`, `FAILED`.

## Spending policy

All limits are in USD, so they do not drift with the HBAR price. They apply to the **cap**, which is the amount actually paid up front.

| Setting | Default | Effect |
| --- | --- | --- |
| `AUTO_APPROVE_LIMIT_USD` | 0.50 | Up to this, the agent pays by itself |
| `DAILY_LIMIT_USD` | 5 | One wallet's total in 24 hours. Passing it needs a person |
| `HARD_CEILING_USD` | 25 | Never paid, and no approval overrides it |
| `GLOBAL_DAILY_LIMIT_USD` | 50 | Everyone's total in 24 hours. Refused beyond it |

Also refused: any recipient that is not the merchant account, an expired quote, and a quote that was already used.

The service-wide limit exists because nothing here proves who is asking. The agent spends the platform's funds, so a per-wallet limit alone could be bypassed by inventing wallet IDs.

## Human approval

`APPROVAL_MODE=wallet` (recommended for anything real) requires a signature from the quote's wallet over the exact approval text. The text names the approval, quote, payment, wallet, recipient, amount, cap, GPU and expiry. The signature is verified against the account's public key from the mirror node, so it cannot be reused for another payment. Both ED25519 and ECDSA keys work, and the format is what Hedera wallets return from `signMessage`.

`APPROVAL_MODE=click` accepts an approval without a signature. It is the default so the flow works without a wallet, and the service warns at startup when it is used outside simulated mode.

An approval is single use, expires (default 5 minutes, and always before its quote), and a rejection is final. Rejecting needs no signature, because rejecting spends nothing.

## Audit log

Every transition is stored and chained: each event includes the hash of the one before it, so changing or removing any event breaks every hash after it. `GET /v1/audit/:paymentId` recomputes the chain.

In testnet mode each event is also posted to a Hedera Consensus Service topic. The message is compact and carries the event hash, which commits to the full details in the database. The topic is created with a **submit key**, so only this service can write to it. Posting is queued and retried, and never blocks or fails a payment. Secrets, signatures and tokens are stripped from event details before anything is stored.

## HTTP API

Everything except health, config, the lease endpoint and the facilitator needs `Authorization: Bearer <SERVICE_TOKEN>`.

| Route | Purpose |
| --- | --- |
| `GET /v1/health`, `GET /v1/config` | Public. Mode, limits and account IDs. No secrets |
| `POST /v1/quotes`, `GET /v1/quotes/:id` | Create and read a quote |
| `POST /v1/payments` | Start a payment for a quote. Repeating it returns the same payment |
| `GET /v1/payments/:id` | The payment, quote, approval, lease and audit events |
| `POST /v1/approvals/:id/decision` | Approve or reject, with an optional wallet signature |
| `POST /v1/payments/:id/lease/complete` | End the lease (simulated development only); the payment is final |
| `GET /v1/audit/:paymentId` | Audit events and chain check |
| `POST /v1/leases` | **The x402-protected endpoint.** 402 first, 200 after payment |
| `GET /facilitator/supported`, `POST /facilitator/verify`, `/settle` | The local facilitator, in simulated and local modes |

## Safety properties

- The amount is fixed by a server-side quote and cannot be changed by the caller.
- The agent refuses to sign if the server raises or lowers the price, changes the recipient, uses another asset, or names an untrusted fee payer. The client library's own spend cap is a second layer.
- A payment is confirmed only after the transaction is read back from the ledger and matches exactly.
- An approval pays once, even if approved twice at the same moment.
- Starting the same quote twice, even concurrently, pays once.
- A payment caught mid-flight by a restart is failed with a note, never retried, so it cannot pay twice. Pending approvals survive a restart.

## Tests

```bash
npm test          # 226 tests, no network, about 10 seconds
npm run live:check # one real payment on testnet (needs credentials)
```

The suite covers the conversion math, policy, quotes, approvals in both modes, the audit chain, the Hedera publisher (with the network call stubbed), the verifier, the simulated ledger, and the whole service end to end over HTTP: automatic payment, approval, rejection, expiry, refusal, a hostile server rewriting the terms, an underfunded agent, refunds, restarts and concurrency.

## What is not covered

- **USDC settlement has only run on the simulated ledger.** The token path is tested end to end with the real x402 client, server and facilitator verification, a wallet stand-in, and mirror-node-shaped records. It has not been run on Hedera testnet, and HashPack signing a token transfer is unverified.

- **Real testnet settlement has not been run from this repository's tests.** The testnet code paths (real facilitator, mirror verification, Hedera Consensus Service posting, merchant refunds) use the official SDK and packages but need credentials to exercise. Run `npm run live:check` to prove them in your environment.
- **Real wallet signing has not been tried with HashPack.** The signed payment is tested with a key emulating a wallet, through the official facilitator verification. HashPack accepting it is unverified.
- **The GPU lease is simulated.** No GPU is rented.
- **Nothing proves who is asking.** The service-wide limit bounds the agent's exposure, but a production deployment should fund the agent from the user's own wallet and require a signed session.
- **The simulated ledger resets** when the service restarts. Payments in the database from before the restart can no longer be verified against it.
- **The original terminal engine** in `payment/` and `index.js` is kept for `npm run cli`. The service reuses only one helper from it, the transaction ID normalizer. Its gaps found in review (fail-open pre-flight, approval token logged on-chain, unused approval timeout, floating-point amounts, a topic with no submit key, a non-exact settlement check) are fixed, and its 14 tests now run with no network and no credentials.
