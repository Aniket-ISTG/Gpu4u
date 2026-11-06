# Manual test: real HashPack payment on Hedera Testnet

**Status: not yet verified.** The code is written and tested against a stand-in wallet and a simulated ledger. Nothing here has been run against the real Hedera testnet or with a real HashPack wallet. HashPack integration is not complete until you finish this checklist and every step passes. If a step fails, stop and report the exact message; do not work around it with a server-held key.

## What you need

| Item | Where to get it |
| --- | --- |
| HashPack set to **Testnet**, with a funded account (at least 20 HBAR) | HashPack, then the faucet at https://portal.hedera.com/faucet |
| A WalletConnect project ID | https://cloud.reown.com (free) |
| A **receiver** testnet account (only its account ID is needed) | https://portal.hedera.com |
| A **fee-payer** testnet account (pays network fees for the local facilitator), at least 20 HBAR | https://portal.hedera.com |

The receiver and fee payer must be two different accounts, and neither may be your HashPack account. Only the fee payer's key goes in `payment-engine/.env`; the receiver needs no key. Never put a seed phrase anywhere. Never put the HashPack key anywhere; the wallet signs in its own app.

## Configure

`payment-engine/.env`:

```
PAYMENT_MODE=testnet
SERVICE_TOKEN=<long random string>
APPROVAL_MODE=click
HEDERA_RECEIVER_ID=0.0.<merchant>
FACILITATOR_MODE=local
FACILITATOR_FEE_PAYER_ID=0.0.<fee payer>
FACILITATOR_FEE_PAYER_KEY=<fee payer key>
# HEDERA_HCS_TOPIC_ID=   leave empty: a topic with a submit key is created on first start
```

`frontend/.env.local`:

```
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=<project id>
PAYMENT_SERVICE_URL=http://127.0.0.1:4021
PAYMENT_SERVICE_TOKEN=<same as SERVICE_TOKEN>
GROQ_API_KEY=<key>
```

Start both (`npm start` in `payment-engine`, `npm run dev` in `frontend`).

## Checks before you touch the wallet

1. The service banner says `Mode: HEDERA TESTNET` and `Payer: the user's connected wallet`, and lists the merchant, the fee payer and an HCS topic. If it refuses to start, the message names the problem (missing key, key does not match the account, low balance). Fix it; it will never fall back to simulated.
2. Optional: `cd payment-engine && npm run live:check`. It uses a test payer key as a **stand-in** for the wallet and proves the ledger, facilitator, HCS and refund paths. It does **not** prove HashPack.

## The HashPack test

Do these in order and note the result of each.

| # | Action | Expected |
| --- | --- | --- |
| 1 | Open http://localhost:3000, click the wallet button, **Connect**, approve in HashPack | Your real account ID shows in the navbar. No manual ID field is offered. |
| 2 | Describe a small task, choose the cheapest GPU, **Rent** | A quote in USD and HBAR for your account. Status: waiting for your signature. Nothing is paid yet. |
| 3 | **Sign with wallet** | HashPack opens a request showing a transfer of the quoted HBAR from you to the merchant. **This is the unverified step.** If HashPack refuses, errors, or shows something else, stop and copy the message. |
| 4 | Approve in HashPack | The page moves through settling and confirming, then shows a **payment receipt** with a transaction ID, a **HashScan** link and a **mirror node** link. |
| 5 | Open the HashScan link | Status SUCCESS. Payer is your account, receiver is the merchant, amount equals the quote, and the fee payer account paid the fee. |
| 6 | Back in the app | A GPU lease is shown only now, with a running lease-time meter. It is labelled lease-time billing, not GPU utilization. |
| 7 | Wait a minute, then **End lease** | The lease closes and shows how long it was held. The payment is final and **nothing is refunded**. No second transaction is created. |
| 8 | Open the audit trail | Events are listed with a check mark for **confirmed on Hedera Consensus Service** and a link to the topic. |
| 9 | Download the final receipt | JSON containing the payment transaction, the lease time and `verifiedOnLedger: true` for the payment. |

### Negative tests

| Action | Expected |
| --- | --- |
| In step 3, **reject** in HashPack | "You rejected the signature in your wallet. Nothing was paid." Your balance is unchanged, no lease. |
| Rent a large job (above the automatic limit, $0.50 by default) | The page asks you to approve first (click), **and then** asks for the wallet signature. Both are required. |
| Reject that approval | No wallet prompt appears and no HBAR moves. |
| Rent something above the hard ceiling ($25 by default) | Refused. No approval is offered. |
| Reload the page mid-payment | The same payment resumes from its stored state. |

## Known risk to watch in step 3

The payment is a partially signed transaction whose transaction ID names the facilitator's fee-payer account while you are the sender. It is pinned to one node so a single wallet signature covers it. This was verified with a key emulating a wallet, but HashPack accepting a transaction whose transaction ID belongs to another account is **unverified**. If HashPack rejects it, the correct response is to report it so the payment design can be reconsidered. It is not to add an agent key or a pre-funded budget.

## Report back

For each row: pass or fail, plus any error text, the payment transaction ID.
