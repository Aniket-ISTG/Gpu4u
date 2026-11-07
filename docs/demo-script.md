# GPU4U demo script (4 min 55 s)

Track: AI Agents That Pay, x402 on Hedera.

## Before you start (not on camera)

- Payment service running in testnet mode (`cd payment-engine && npm start`) and the web app (`cd frontend && npm run dev`).
- Terminal 1 in `payment-engine`, font large. Browser tabs open and ready: HashScan topic `0.0.11342109`, HashScan account `0.0.11346382` (the agent), and the web app at `/get-started`.
- Agent account funded: `curl -s https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.11346382 | jq .balance.balance` should be above 100000000 (1 HBAR).
- Do one dry run an hour before: `npm run agent -- "<task>" --dry-run`. If Groq answers 429 ("busy") during the demo, wait 20 s and rerun.
- Backup: keep a screen recording of one full run.

## 0:00 – 0:40 The problem

**Screen 1 (0:00–0:10):** one big line: *"GPU compute is scarce."* Three words fade in under it: *Demand. Waitlists. Price swings.*

**Say:** "GPUs are the scarcest resource in AI. Demand outruns supply, and the same GPU can cost very different amounts depending on who has one free right now."

**Screen 2 (0:10–0:26):** a grid of browser tabs, one per GPU marketplace, each showing a different price for a similar card. A cursor clicks through them one by one. Caption: *"One human. Every marketplace. Every day."*

**Say:** "So a fair price means a human opens every marketplace, filters by memory and speed, works out the total cost of the job, and compares. By the time you finish, the cheap offer is gone."

**Screen 3 (0:26–0:40):** the tabs collapse into the GPU4U prompt box with the task typed in. Then a wall slides in: *"Account. Card. API key."* with a red *"Human required."*

**Say:** "That is the core problem. Finding compute is manual, and paying for it is manual too. An agent can search for us, but it can't open an account, add a card or paste a key. Hand it your card and it's a blank cheque. GPU4U fixes both: it searches every marketplace, and then the agent pays for itself, inside limits you set."

## 0:40 – 1:10 The idea

**Say:** "Here is how. x402 brings back HTTP 402, Payment Required. The server quotes a price, the agent signs a payment, and the request goes through. No checkout, no signup. On Hedera the facilitator pays the network fee, so the agent needs no gas.

GPU4U takes a task in plain English, compares about 450 live offers across providers, picks the cheapest GPU that fits, pays for it with x402, and proves what it paid. Everything you will see is on Hedera testnet."

**Screen:** the architecture diagram in the README.

## 1:10 – 3:20 Live demo: the autonomous agent

**Run (terminal):**

```bash
npm run agent -- "Run inference for 2000 prompts on a 7B model, cheapest option" --max-total 0.30 --lease-seconds 5
```

Narrate each step as it prints (it takes about 40 seconds):

- **[1 Discover]** "The agent finds the paid endpoint from a public discovery document. It learns the network, the asset, who gets paid and the spending limits it must obey. Nobody told it a URL or a key."
- **[3 Compare]** "This is the tab-hopping a human would do, in seconds: 447 live offers, 43 fit the task. It picks the cheapest and checks that it really is the cheapest."
- **[4–5 Quote and policy]** "The price is set by the server, never by the agent. This is under 50 cents, so policy says auto: the agent may pay by itself."
- **[6 The 402]** "Now it asks the endpoint for the price and gets HTTP 402 with the exact amount for this quote. It compares that to its quote before signing. If the server raised the price by one tinybar, it would refuse."
- **[7–8 Pay and verify]** "It signs with its own key. The facilitator pays the fee and submits. Then the agent does not take anyone's word: it reads the transaction back from the public mirror node and checks the merchant got exactly the amount."

**Switch to HashScan** and paste the transaction ID the agent printed. Point at: SUCCESS, the amount to the merchant, the fee paid by the facilitator account.

**Say:** "A real transaction on Hedera. No human approved it."

## 3:20 – 4:05 The guardrail: it knows when to stop

**Run (terminal):**

```bash
npm run agent -- "Train a 1B parameter model from scratch on 500 million tokens, cheapest option" --max-total 1.0 --dry-run
```

**Say:** "Now a bigger job. $1.05 is above the 50 cent limit, so the policy says approval. Watch: the agent stops, exit code 2, and pays nothing. Above the limit a human decides. Over the hard ceiling or to an unknown recipient it is refused outright. That is how you give an agent a budget, not a blank cheque."

**Optional, if time:** open the web app, show the same payment waiting on the Approve button.

## 4:05 – 4:35 The proof trail

**Show:** HashScan topic `0.0.11342109`, the latest messages.

**Say:** "Every step the agent took, from the policy decision to the lease, is hash-chained and posted to a Hedera Consensus Service topic that only our service can write to. If anyone edits a past event, every hash after it breaks. That is a tamper-evident record of what each agent spent and why."

## 4:35 – 4:55 Close

**Say:** "GPUs are scarce, and the hunt for the best deal and the payment were both stuck on a human. So: a live marketplace router, an agent that pays with x402 and no human, spending controls, and an audit trail on HCS. It runs on our own facilitator and also works with the hosted Hedera ones. The GPU lease itself is simulated for now, and USDC support is built and tested on a simulated ledger. Everything else you just saw is real. GPU4U: agents that can pay, and spend only what you allow."

## If something goes wrong

| Problem | Do this |
| --- | --- |
| "AI service is busy" (429) | Wait 20 seconds and rerun, or play the backup recording |
| Marketplace slow (3 s) | Say "live feed, about 450 offers" and carry on |
| Audit events not all confirmed yet | Say "they post in order and confirm within a minute", and show the ones that are there |
| Judge asks "is the GPU real?" | "The lease is simulated. The marketplace prices and the payment are real. Renting needs a provider account." |
| Judge asks "why not a hosted facilitator?" | "We run our own to prove the full flow, and the service can point at Blocky402, the official facilitator or Launa with one setting." |
