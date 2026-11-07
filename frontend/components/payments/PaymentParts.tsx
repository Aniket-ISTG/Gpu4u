"use client";

import { useEffect, useState } from "react";
import type { LedgerLinks, PaymentConfig, PaymentRequirementsResponse, PaymentView, Quote, Receipt } from "@/lib/payments/types";
import { formatCountdown, secondsLeft, type Step } from "@/lib/payments/steps";
import { formatDuration, meterLeaseTime } from "@/lib/payments/lease-meter";

export const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

const card = "rounded-md border border-[#A5A79B]/25 bg-[#0B1728]/80 p-4";
const label = "text-[11px] font-display font-bold uppercase tracking-wider text-[#A5A79B]";
const primaryButton =
  "rounded-sm bg-[#E8D2B5] px-4 py-2 text-xs font-display font-bold uppercase tracking-wider text-[#0B1728] hover:bg-[#FAF4EB] disabled:cursor-not-allowed disabled:opacity-50";

const STEP_STYLE: Record<Step["state"], { dot: string; text: string; mark: string }> = {
  done: { dot: "bg-emerald-400/90 text-[#0B1728]", text: "text-[#FAF4EB]", mark: "✓" },
  active: { dot: "bg-[#E8D2B5] text-[#0B1728] animate-pulse", text: "text-[#FAF4EB]", mark: "•" },
  pending: { dot: "border border-[#A5A79B]/40 text-[#A5A79B]", text: "text-[#A5A79B]", mark: "" },
  skipped: { dot: "border border-[#A5A79B]/30 text-[#A5A79B]", text: "text-[#A5A79B]", mark: "–" },
  failed: { dot: "bg-red-400 text-[#0B1728]", text: "text-red-200", mark: "!" },
};

export function SimulatedBanner({ config }: { config: PaymentConfig | null }) {
  if (!config) return null;
  if (config.simulated) {
    return (
      <p className="rounded-sm border border-[#E8D2B5]/40 bg-[#112540]/70 p-3 text-xs text-[#E8D2B5]">
        <strong>Simulated payments.</strong>{" "}
        {config.payer === "wallet"
          ? "The payment flow is real, but the money moves on an in-memory ledger, and a real wallet cannot sign for it."
          : "The agent pays through the real x402 flow, but the money moves on an in-memory ledger."}{" "}
        Nothing is sent to Hedera, so there is no transaction to verify on HashScan. An operator turns on real settlement with PAYMENT_MODE=testnet.
      </p>
    );
  }
  return (
    <p className="rounded-sm border border-emerald-400/30 bg-[#112540]/70 p-3 text-xs text-[#E8D2B5]">
      <strong>Hedera testnet.</strong> Your wallet signs every payment, and it settles on the real testnet. The testnet HBAR and USDC have no market value. Every
      transaction can be checked on HashScan.
    </p>
  );
}

/** Copies text, and says so. */
export function CopyButton({ text, name }: { text: string; name: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => setCopied(false));
      }}
      className="rounded-sm border border-[#A5A79B]/40 px-2 py-0.5 text-[10px] font-bold uppercase text-[#E8D2B5] hover:bg-[#112540]"
      aria-label={`Copy ${name}`}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** How to check a transaction on the public ledger. Shown only when the transaction is really on Hedera. */
type LedgerState = { state: "loading" } | { state: "found"; result: string; name: string; at: string; fee: number } | { state: "missing" };

/** Reads the transaction's status straight from the Hedera testnet mirror node, so it does not depend on this app's word. */
function LedgerStatus({ mirrorUrl }: { mirrorUrl: string }) {
  const [status, setStatus] = useState<LedgerState>({ state: "loading" });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 6 && !cancelled; attempt++) {
        try {
          const res = await fetch(mirrorUrl, { cache: "no-store" });
          if (res.ok) {
            const tx = (await res.json())?.transactions?.[0];
            if (tx && !cancelled) {
              setStatus({ state: "found", result: String(tx.result), name: String(tx.name), at: String(tx.consensus_timestamp), fee: Number(tx.charged_tx_fee) || 0 });
              return;
            }
          }
        } catch {
          // keep trying: the mirror node can lag a few seconds behind consensus
        }
        await new Promise((r) => setTimeout(r, 2500));
      }
      if (!cancelled) setStatus({ state: "missing" });
    })();
    return () => {
      cancelled = true;
    };
  }, [mirrorUrl]);

  if (status.state === "loading") return <p className="text-xs text-[#A5A79B]">Checking the Hedera testnet ledger…</p>;
  if (status.state === "missing") {
    return <p className="text-xs text-amber-200">The mirror node has not returned this transaction yet. Open the HashScan link and refresh in a few seconds.</p>;
  }
  const ok = status.result === "SUCCESS";
  const when = new Date(Number(status.at.split(".")[0]) * 1000).toLocaleString();
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-[#A5A79B]">
      Ledger status
      <span className={"rounded-sm px-2 py-0.5 text-[11px] font-bold " + (ok ? "bg-emerald-500/20 text-emerald-200" : "bg-red-500/20 text-red-200")}>{status.result}</span>
      <span>
        {status.name} · consensus {when} · fee {(status.fee / 1e8).toFixed(6)} HBAR
      </span>
    </p>
  );
}

export function VerificationLinks({ links, transactionId, title }: { links: LedgerLinks | null; transactionId: string | null; title: string }) {
  if (!links || (!links.hashscan && !links.mirrorApi)) return null;
  return (
    <div className="space-y-2 rounded-sm border border-emerald-400/30 bg-[#091424]/90 p-3">
      <p className="text-[11px] font-display font-bold uppercase tracking-wider text-emerald-200">{title}</p>
      {transactionId && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-[#A5A79B]">
          Transaction ID <span className="break-all font-mono text-[#E8D2B5]">{transactionId}</span>
          <CopyButton text={transactionId} name="transaction ID" />
        </p>
      )}
      {links.mirrorApi && <LedgerStatus mirrorUrl={links.mirrorApi} />}
      <ul className="space-y-1 text-xs">
        {links.hashscan && (
          <li>
            <a className="font-bold text-[#E8D2B5] underline hover:text-[#FAF4EB]" href={links.hashscan} target="_blank" rel="noreferrer">
              Open on HashScan
            </a>{" "}
            <span className="text-[#A5A79B]">the Hedera explorer, easiest to read</span>
          </li>
        )}
        {links.mirrorApi && (
          <li>
            <a className="font-bold text-[#E8D2B5] underline hover:text-[#FAF4EB]" href={links.mirrorApi} target="_blank" rel="noreferrer">
              Open the mirror node record
            </a>{" "}
            <span className="text-[#A5A79B]">the raw ledger data (JSON) anyone can fetch and compare</span>
          </li>
        )}
      </ul>
    </div>
  );
}

export function QuoteCard({ quote, now, children }: { quote: Quote; now: number; children?: React.ReactNode }) {
  const left = secondsLeft(quote.expiresAt, now);
  const preview = quote.policyPreview;
  const decision = preview?.decision;
  return (
    <div className={card + " space-y-3"}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className={label}>Quote</p>
          <p className="font-display text-lg font-bold text-[#FAF4EB]">
            {quote.offer.gpuModel} ×{quote.offer.gpuCount} · {quote.offer.provider}
          </p>
        </div>
        <span className={`rounded-sm px-2 py-1 font-mono text-xs ${left > 0 ? "bg-[#1E3A5F] text-[#E8D2B5]" : "bg-red-900/60 text-red-200"}`}>
          {left > 0 ? `valid ${formatCountdown(left)}` : "expired"}
        </span>
      </div>

      <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <Row k="Estimated run" v={`${quote.hours.toFixed(2)} h at ${usd(quote.hourlyUsd)}/h`} />
        <Row k="Estimated cost" v={usd(quote.estimateUsd)} />
        <Row k="You pay up to (cap)" v={usd(quote.capUsd)} strong />
        <Row k={`In ${quote.assetSymbol}`} v={`${quote.amountDisplay} ${quote.assetSymbol}`} strong />
        {quote.rate.usdPerHbar != null ? (
          <Row k="Rate" v={`$${quote.rate.usdPerHbar.toFixed(6)} per HBAR (${quote.rate.source === "hedera-mirror-node" ? "Hedera network rate" : "fixed fallback"})`} />
        ) : (
          <Row k="Rate" v={`1 ${quote.assetSymbol} = $1 (no exchange rate)`} />
        )}
        <Row k="Pay to" v={quote.payTo} mono />
      </dl>

      {quote.providerEntry && (
        <div className="space-y-1 rounded-sm border border-[#E8D2B5]/20 bg-[#091424]/90 p-3">
          <p className={label}>Provider entry (mock)</p>
          <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            <Row k="Entry" v={quote.providerEntry.id} mono />
            <Row k="Provider" v={`${quote.providerEntry.provider} · ${quote.providerEntry.region}`} />
            <Row k="Receiver account" v={quote.providerEntry.receiverAccountId} mono strong />
            <Row k="Receiver set by" v={quote.providerEntry.receiverSource} />
          </dl>
          <p className="text-xs text-[#A5A79B]">Your connected wallet pays this account. The marketplace provider is not paid on-chain.</p>
        </div>
      )}

      <p className="text-xs text-[#A5A79B]">
        You are charged for the time the lease is held, by the second, up to the cap. The payment is final: nothing is refunded.
      </p>

      {preview && (
        <p
          className={`rounded-sm p-2 text-xs ${
            decision === "auto"
              ? "bg-emerald-900/30 text-emerald-100"
              : decision === "approval"
                ? "bg-[#1E3A5F]/60 text-[#E8D2B5]"
                : "bg-red-900/40 text-red-100"
          }`}
        >
          {decision === "auto" && `This is within the automatic limit of ${usd(preview.limits.autoApproveLimitUsd)}, so no approval is needed. Your wallet still has to sign the payment.`}
          {decision === "approval" && `You must approve this payment first, then sign it in your wallet. ${preview.reasons.join(" ")}`}
          {decision === "refuse" && `This payment will be refused. ${preview.reasons.join(" ")}`}
        </p>
      )}
      {children}
    </div>
  );
}

function Row({ k, v, strong, mono }: { k: string; v: string; strong?: boolean; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-[#A5A79B]">{k}</dt>
      <dd className={`text-right ${strong ? "font-bold text-[#FAF4EB]" : "text-[#E8D2B5]"} ${mono ? "font-mono break-all" : ""}`}>{v}</dd>
    </div>
  );
}

export function Timeline({ steps }: { steps: Step[] }) {
  return (
    <ol className={card + " space-y-3"} aria-label="Payment progress">
      {steps.map((step) => {
        const style = STEP_STYLE[step.state];
        return (
          <li key={step.key} className="flex items-start gap-3">
            <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${style.dot}`} aria-hidden>
              {style.mark}
            </span>
            <div>
              <p className={`text-sm font-bold font-display ${style.text}`}>
                {step.label}
                <span className="sr-only"> ({step.state})</span>
              </p>
              <p className="text-xs text-[#A5A79B]">{step.detail}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function ApprovalCard({
  view, now, mode, canSign, busy, error, onApprove, onReject,
}: {
  view: PaymentView; now: number; mode: "click" | "wallet"; canSign: boolean; busy: boolean; error: string | null;
  onApprove: () => void; onReject: () => void;
}) {
  const approval = view.approval;
  if (!approval) return null;
  const left = secondsLeft(approval.expiresAt, now);
  const blocked = mode === "wallet" && !canSign;
  const walletPays = view.payerMode === "wallet";
  return (
    <div className={card + " space-y-3 border-[#E8D2B5]/50"}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className={label}>Your approval is needed</p>
          <p className="text-sm text-[#FAF4EB]">
            {view.payment.decisionReasons.join(" ") || "This payment is above the automatic limit."}
          </p>
        </div>
        <span className="rounded-sm bg-[#1E3A5F] px-2 py-1 font-mono text-xs text-[#E8D2B5]">{formatCountdown(left)}</span>
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-sm border border-[#A5A79B]/25 bg-[#07101C] p-3 font-mono text-[11px] leading-relaxed text-[#E8D2B5]">
        {approval.message}
      </pre>
      <p className="text-xs text-[#A5A79B]">
        {walletPays
          ? "Approving records your decision. Nothing is paid yet: your wallet must then sign the payment, and both are required."
          : mode === "wallet"
            ? "Approving asks your wallet to sign exactly this text. The signature is checked against your account, and it cannot be reused for another payment."
            : "Approving by click is accepted on this server. A wallet signature is not required."}
      </p>
      {blocked && (
        <p className="text-xs text-[#E8D2B5]">Connect a wallet that can sign messages, such as HashPack, to approve this payment.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || blocked || left === 0} onClick={onApprove} className={primaryButton}>
          {busy ? "Working…" : mode === "wallet" && !walletPays ? "Sign and approve" : "Approve"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onReject}
          className="rounded-sm border border-[#A5A79B]/40 px-4 py-2 text-xs font-display font-bold uppercase tracking-wider text-[#E8D2B5] hover:bg-[#112540] disabled:opacity-50"
        >
          Reject
        </button>
      </div>
      {error && <p className="text-xs text-red-200">{error}</p>}
    </div>
  );
}

/** The step where the user's wallet is asked to sign the exact payment. */
export function SignCard({
  view, now, terms, canSign, busy, error, onSign,
}: {
  view: PaymentView; now: number; terms: PaymentRequirementsResponse | null; canSign: boolean; busy: boolean; error: string | null; onSign: () => void;
}) {
  const { quote } = view;
  const left = secondsLeft(quote.expiresAt, now);
  const feePayer = terms?.required.accepts[0]?.extra?.feePayer;
  return (
    <div className={card + " space-y-3 border-[#E8D2B5]/50"}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className={label}>Sign the payment in your wallet</p>
          <p className="text-sm text-[#FAF4EB]">
            Your wallet will show a transfer of <strong>{quote.amountDisplay} {quote.assetSymbol}</strong> from your account <span className="font-mono">{quote.wallet}</span> to the
            merchant <span className="font-mono">{quote.payTo}</span>.
          </p>
        </div>
        <span className="rounded-sm bg-[#1E3A5F] px-2 py-1 font-mono text-xs text-[#E8D2B5]">{left > 0 ? formatCountdown(left) : "expired"}</span>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-xs text-[#A5A79B]">
        <li>This is the exact payment you were quoted: up to {usd(quote.capUsd)}, in {quote.assetSymbol}, to one account. It cannot be changed.</li>
        <li>
          The network fee is paid by the facilitator{feePayer ? <> (<span className="font-mono">{feePayer}</span>)</> : null}, not by you.
        </li>
        <li>Nothing is paid until you sign. If you reject it in the wallet, nothing moves.</li>
        <li>After you sign, the payment settles on Hedera testnet and is read back from the ledger before your lease starts.</li>
      </ul>
      {!canSign && <p className="text-xs text-[#E8D2B5]">Connect a wallet that can sign, such as HashPack, to pay. An account ID alone cannot sign.</p>}
      <button type="button" disabled={busy || !canSign || left === 0} onClick={onSign} className={primaryButton}>
        {busy ? "Waiting for your wallet…" : "Sign with my wallet"}
      </button>
      {error && <p className="text-xs text-red-200" role="alert">{error}</p>}
    </div>
  );
}

export function ReceiptCard({ view, config }: { view: PaymentView; config: PaymentConfig | null }) {
  const { payment, quote } = view;
  const simulated = payment.mode === "simulated";
  return (
    <div className={card + " space-y-3"}>
      <div className="flex items-center justify-between gap-2">
        <p className={label}>Payment confirmed</p>
        <span className={`rounded-sm px-2 py-0.5 text-[10px] font-bold uppercase ${simulated ? "bg-[#1E3A5F] text-[#E8D2B5]" : "bg-emerald-900/50 text-emerald-100"}`}>
          {simulated ? "Simulated, not on Hedera" : "Hedera testnet"}
        </span>
      </div>
      <dl className="space-y-1 text-xs">
        <Row k="Paid" v={`${quote.amountDisplay} ${quote.assetSymbol} (up to ${usd(quote.capUsd)})`} strong />
        <Row k="Paid to" v={quote.payTo} mono />
        <Row k="Paid by" v={payment.settlement?.payer ?? config?.accounts.agent ?? "wallet"} mono />
        <Row k="Network fee paid by" v={payment.settlement?.feePayer ?? "the facilitator"} mono />
        {payment.settlement?.consensusTimestamp && <Row k="Consensus time" v={payment.settlement.consensusTimestamp} mono />}
        <Row k="Read back from the ledger" v={payment.settlement?.verified ? "Yes, it matched the quote exactly" : "No"} />
      </dl>
      {simulated ? (
        <p className="text-xs text-[#A5A79B]">There is no transaction to verify on HashScan because this payment was simulated.</p>
      ) : (
        <VerificationLinks links={view.links.payment} transactionId={payment.transactionId} title="Verify this payment on Hedera testnet" />
      )}
    </div>
  );
}

/** The lease clock: how long it has run, what it has cost so far, and when it reaches the cap. */
export function LeaseMeterCard({ view, serverNow, busy, onEnd }: { view: PaymentView; serverNow: number; busy: boolean; onEnd: () => void }) {
  const lease = view.lease;
  if (!lease) return null;
  const { quote } = view;
  const meter = meterLeaseTime({ hourlyUsd: quote.hourlyUsd, capUsd: quote.capUsd, startedAtMs: lease.createdAt, nowMs: serverNow });
  const unitsPerUsd = Number(quote.amountDisplay) / quote.capUsd;
  return (
    <div className={card + " space-y-3 border-emerald-400/30"}>
      <div className="flex items-center justify-between gap-2">
        <p className={label}>Lease running</p>
        <span className="rounded-sm bg-[#1E3A5F] px-2 py-0.5 text-[10px] font-bold uppercase text-[#E8D2B5]">Lease-time billing</span>
      </div>
      <p className="text-sm text-[#FAF4EB]">
        {quote.offer.gpuModel} ×{quote.offer.gpuCount} · {quote.offer.provider}
      </p>
      <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <Row k="Lease held for" v={formatDuration(meter.elapsedSeconds)} strong />
        <Row k="Cost so far" v={`${usd(meter.usd)} · ${(meter.usd * unitsPerUsd).toFixed(4)} ${quote.assetSymbol}`} strong />
        <Row k="Price" v={`${usd(quote.hourlyUsd)} per hour, billed by the second`} />
        <Row k="Reaches the cap in" v={meter.stoppedAtCap ? "now" : formatDuration(meter.capSeconds - meter.elapsedSeconds)} />
      </dl>
      <div className="h-2 overflow-hidden rounded-sm border border-[#A5A79B]/20 bg-[#070F1C]" aria-label="Share of the cap used">
        <div className="h-full bg-[#E8D2B5] transition-all" style={{ width: `${(meter.capFraction * 100).toFixed(1)}%` }} />
      </div>
      <p className="text-[11px] text-[#A5A79B]">
        This shows how long the lease has been held. It is not a measurement of how much of the GPU was used. Your payment is final and is not refunded
        when the lease ends.
      </p>
      <button type="button" className={primaryButton} disabled={busy} onClick={onEnd}>
        {busy ? "Ending…" : "End the lease"}
      </button>
    </div>
  );
}

export function ReconciliationCard({ view }: { view: PaymentView }) {
  const rec = view.lease?.reconciliation;
  if (!rec) return null;
  const leaseTime = rec.billingBasis === "lease-time";
  return (
    <div className={card + " space-y-3 border-emerald-400/30"}>
      <div className="flex items-center justify-between gap-2">
        <p className={label}>Lease ended</p>
        <span className="rounded-sm bg-[#1E3A5F] px-2 py-0.5 text-[10px] font-bold uppercase text-[#E8D2B5]">
          {leaseTime ? "Lease time" : "Simulated run"}
        </span>
      </div>
      <p className="text-sm text-[#FAF4EB]">
        {rec.runStatus === "stopped_at_cap" ? "The lease reached its cap and was closed." : "The lease ended within its cap."}
      </p>
      <dl className="space-y-1 text-xs">
        <Row k={leaseTime ? "Held for" : "Used (simulated)"} v={formatDuration(rec.actualDurationHours * 3600)} strong />
        <Row k="Paid (final)" v={`${rec.paidDisplay} ${rec.asset.symbol}`} strong />
        <Row k="Refund" v="None. Payments are final." />
      </dl>
      <p className="text-[11px] text-[#A5A79B]">{rec.billingNote}</p>
    </div>
  );
}

/** The final receipt, once everything has settled. Downloadable, with a ledger link for each transaction. */
export function FinalReceiptCard({ receipt }: { receipt: Receipt }) {
  const download = () => {
    const blob = new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gpu4u-receipt-${receipt.quote.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const { anchors } = receipt.audit;
  return (
    <div className={card + " space-y-3 border-[#E8D2B5]/50"}>
      <div className="flex items-center justify-between gap-2">
        <p className={label}>Final receipt</p>
        <span className={`rounded-sm px-2 py-0.5 text-[10px] font-bold uppercase ${receipt.simulated ? "bg-[#1E3A5F] text-[#E8D2B5]" : "bg-emerald-900/50 text-emerald-100"}`}>
          {receipt.simulated ? "Simulated" : "Hedera testnet"}
        </span>
      </div>
      <dl className="space-y-1 text-xs">
        <Row k="GPU" v={`${receipt.offer.gpuModel} ×${receipt.offer.gpuCount} · ${receipt.offer.provider}`} />
        <Row k="Paid by" v={receipt.payer.wallet} mono />
        <Row k="Paid" v={`${receipt.quote.paidDisplay} ${receipt.quote.asset.symbol}`} />
        {receipt.lease && <Row k="Lease held" v={`${receipt.lease.billedSeconds ?? "?"} s`} />}
        <Row k="Refund" v="None. Payments are final." />
        <Row k="Audit" v={`${receipt.audit.events} events · chain ${receipt.audit.chainIntact ? "intact" : "BROKEN"}`} />
        {!receipt.simulated && (
          <Row k="Anchored on Hedera" v={`${anchors.confirmed} confirmed · ${anchors.published} awaiting confirmation · ${anchors.failed} failed`} />
        )}
      </dl>
      {receipt.simulated ? (
        <p className="text-xs text-[#A5A79B]">This payment was simulated, so there are no transactions to verify on Hedera.</p>
      ) : (
        <div className="space-y-2">
          <VerificationLinks links={receipt.payment.links} transactionId={receipt.payment.transactionId} title="Payment transaction" />
          {receipt.audit.topic.id && <VerificationLinks links={receipt.audit.topic.links} transactionId={null} title={`Audit topic ${receipt.audit.topic.id}`} />}
        </div>
      )}
      <button type="button" className={primaryButton} onClick={download}>
        Download receipt (JSON)
      </button>
    </div>
  );
}

const HCS_STYLE: Record<string, string> = {
  CONFIRMED: "bg-emerald-900/50 text-emerald-100",
  PUBLISHED: "bg-[#1E3A5F] text-[#E8D2B5]",
  UNCONFIRMED: "bg-[#1E3A5F] text-[#E8D2B5]",
  MISMATCH: "bg-red-900/60 text-red-100",
  FAILED: "bg-red-900/50 text-red-100",
};

export function AuditTrail({ view }: { view: PaymentView }) {
  return (
    <details className={card}>
      <summary className="cursor-pointer text-xs font-display font-bold uppercase tracking-wider text-[#E8D2B5]">
        Audit trail · {view.events.length} events ·{" "}
        <span className={view.chain.valid ? "text-emerald-300" : "text-red-300"}>
          {view.chain.valid ? "hash chain intact" : `chain broken at event ${view.chain.brokenAtSeq}`}
        </span>
      </summary>
      <ol className="mt-3 space-y-1.5">
        {view.events.map((event) => (
          <li key={event.seq} className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
            <span>
              <span className="font-mono text-[#A5A79B]">{String(event.seq).padStart(2, "0")}</span>{" "}
              <span className="font-mono text-[#FAF4EB]">{event.eventType}</span>
            </span>
            <span className="flex items-center gap-2 text-[#A5A79B]">
              <span className="font-mono" title={event.hash}>{event.hash.slice(7, 15)}</span>
              <span
                className={`rounded-sm px-1.5 py-0.5 text-[10px] uppercase ${HCS_STYLE[event.hcs.status] ?? "bg-[#1E3A5F] text-[#E8D2B5]"}`}
                title={event.hcs.sequence ? `Hedera Consensus Service message ${event.hcs.sequence}` : undefined}
              >
                {event.hcs.status === "CONFIRMED"
                  ? `HCS #${event.hcs.sequence ?? ""} ✓`
                  : event.hcs.status === "PUBLISHED"
                    ? `HCS #${event.hcs.sequence ?? ""}`
                    : event.hcs.status === "LOCAL"
                      ? "local"
                      : event.hcs.status.toLowerCase()}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {view.links.topic.hashscan && (
        <p className="mt-3 text-xs">
          <a className="font-bold text-[#E8D2B5] underline" href={view.links.topic.hashscan} target="_blank" rel="noreferrer">
            Open the audit topic on HashScan
          </a>
        </p>
      )}
      <p className="mt-3 text-[11px] text-[#A5A79B]">
        Each event includes the hash of the one before it, so changing or removing any event breaks the chain. On testnet each event is also posted to a
        Hedera Consensus Service topic that only this service can write to, then read back from the mirror node to confirm it matches. A tick means
        the ledger holds exactly that message.
      </p>
    </details>
  );
}
