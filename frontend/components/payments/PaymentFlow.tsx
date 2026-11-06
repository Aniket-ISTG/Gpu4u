"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RoutedOffer, RoutingConstraints } from "@/lib/routing/cost-ranking";
import type { Difficulty } from "@/lib/estimation/difficulty";
import type { WorkloadProfile } from "@/lib/estimation/workload-profile";
import { apiRequest, ApiError } from "@/lib/payments/api";
import { deriveSteps } from "@/lib/payments/steps";
import {
  TERMINAL_STATUSES,
  type PaymentRequirementsResponse,
  type PaymentView,
  type Quote,
  type Receipt,
} from "@/lib/payments/types";
import { useWallet } from "@/components/wallet/WalletProvider";
import {
  ApprovalCard, AuditTrail, FinalReceiptCard, LeaseMeterCard, QuoteCard, ReceiptCard, ReconciliationCard,
  SignCard, SimulatedBanner, Timeline, usd,
} from "./PaymentParts";

export interface RentRequest {
  profile: WorkloadProfile;
  touched: (keyof WorkloadProfile)[];
  difficulty: Difficulty | null;
  constraints: RoutingConstraints;
}

interface Props {
  routed: RoutedOffer;
  /** Auto mode: take the quote, start the payment and open the wallet's signature request without clicks. */
  auto?: boolean;
  request: RentRequest;
}

const POLL_MS = 1500;
const LEASE_POLL_MS = 5000;

type Busy = null | "quote" | "pay" | "decide" | "sign" | "run" | "end" | "retry";

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "PRICE_CHANGED" && typeof error.details.estimateUsd === "number") {
      return `The price changed. The new estimate is ${usd(error.details.estimateUsd)}. Rank again and review it before continuing.`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

const button =
  "rounded-sm px-4 py-2.5 text-xs font-display font-bold uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Rent one GPU: lock a quote, apply the spending policy, ask the owner when the amount is above the limit, then
 * have the user's wallet sign the exact payment. After it settles on Hedera and is read back from the ledger, the
 * lease runs until it is ended. Payments are final: nothing is refunded.
 *
 * In simulated development with an agent payer the old flow still applies: the agent pays and the run is simulated.
 * Mount it with a key of the offer ID so choosing a different GPU starts a fresh flow.
 */
export default function PaymentFlow({ routed, request, auto = false }: Props) {
  const wallet = useWallet();
  const config = wallet.paymentConfig;
  const walletMode = config?.payer === "wallet";

  const [quote, setQuote] = useState<Quote | null>(null);
  const [view, setView] = useState<PaymentView | null>(null);
  const [terms, setTerms] = useState<PaymentRequirementsResponse | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [capInput, setCapInput] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // The service's clock minus ours, so the lease timer follows the clock that does the billing.
  const [clockOffset, setClockOffset] = useState(0);

  const adopt = useCallback((next: PaymentView) => {
    setView(next);
    setClockOffset(next.serverTime - Date.now());
  }, []);

  const paymentId = view?.payment.id ?? null;
  const status = view?.payment.status ?? null;
  const leaseRunning = status === "LEASE_ACTIVE" && walletMode;
  // Stop polling at a resting state. A running wallet lease keeps polling slowly, since it can close by itself at its cap.
  const settled = status !== null && (TERMINAL_STATUSES.includes(status) || (status === "LEASE_ACTIVE" && !walletMode));

  useEffect(() => {
    if (!paymentId || settled) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const next = await apiRequest<PaymentView>("GET", `/api/payments/${paymentId}`);
        if (!cancelled) adopt(next);
      } catch (e) {
        if (!cancelled) setError(messageFor(e));
      }
    }, leaseRunning ? LEASE_POLL_MS : POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [paymentId, settled, leaseRunning, adopt]);

  // The final receipt, once everything has settled.
  useEffect(() => {
    if (!paymentId || status !== "RECONCILED") return;
    let cancelled = false;
    apiRequest<Receipt>("GET", `/api/payments/${paymentId}/receipt`)
      .then((r) => !cancelled && setReceipt(r))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [paymentId, status]);

  // A once-a-second clock for countdowns and the lease meter.
  const ticking = Boolean(quote) || status === "PENDING_APPROVAL" || status === "AWAITING_SIGNATURE" || leaseRunning;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  const run = useCallback(async <T,>(kind: NonNullable<Busy>, work: () => Promise<T>): Promise<T | undefined> => {
    setError(null);
    setBusy(kind);
    try {
      return await work();
    } catch (e) {
      setError(messageFor(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);

  const requestQuote = () =>
    run("quote", async () => {
      const cap = capInput.trim() ? Number(capInput) : undefined;
      const response = await apiRequest<{ quote: Quote }>("POST", "/api/quotes", {
        wallet: wallet.account,
        offerId: routed.offer.id,
        ...request,
        ...(cap && Number.isFinite(cap) ? { capUsd: cap } : {}),
        expectedEstimateUsd: routed.estimatedTotalCostUsd,
      });
      setNow(Date.now());
      setQuote(response.quote);
    });

  const startPayment = () =>
    run("pay", async () => {
      if (!quote) return;
      adopt(await apiRequest<PaymentView>("POST", "/api/payments", { quoteId: quote.id }));
    });

  const decide = (decision: "approve" | "reject") =>
    run("decide", async () => {
      if (!view?.approval || !wallet.account) return;
      let signatureMap: string | undefined;
      if (decision === "approve" && config?.approvalMode === "wallet" && !walletMode) {
        signatureMap = await wallet.signMessage(view.approval.message);
      }
      adopt(
        await apiRequest<PaymentView>("POST", `/api/approvals/${view.approval.id}/decision`, {
          decision,
          wallet: wallet.account,
          ...(signatureMap ? { signatureMap } : {}),
        }),
      );
    });

  /** The wallet signs the exact payment, and it is submitted. Nothing is paid if the user rejects it. */
  const signPayment = () =>
    run("sign", async () => {
      if (!paymentId) return;
      const required = await apiRequest<PaymentRequirementsResponse>("GET", `/api/payments/${paymentId}/requirements`);
      setTerms(required);
      const signed = await wallet.signPayment(required);
      adopt(await apiRequest<PaymentView>("POST", `/api/payments/${paymentId}/submit`, { paymentPayload: signed.payload }));
    });

  const endLease = () =>
    run("end", async () => {
      if (!paymentId) return;
      adopt(await apiRequest<PaymentView>("POST", `/api/payments/${paymentId}/end`));
    });

  const runSimulatedLease = () =>
    run("run", async () => {
      if (!paymentId) return;
      adopt(await apiRequest<PaymentView>("POST", `/api/payments/${paymentId}/run`));
    });

  const startOver = () => {
    setQuote(null);
    setView(null);
    setTerms(null);
    setReceipt(null);
    setError(null);
  };

  const canPay = Boolean(wallet.account) && (!walletMode || wallet.canSign);

  // Auto mode does each step once. It never signs for the user: the wallet still asks, and a rejection
  // leaves the manual button in place. A payment that needs the owner's approval still waits for it.
  const autoDone = useRef({ quote: false, pay: false, sign: false });
  const sectionRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (auto) sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [auto]);
  useEffect(() => {
    if (!auto || busy !== null || wallet.configError) return;
    const steps = autoDone.current;
    if (!view && !quote && canPay && !steps.quote) {
      steps.quote = true;
      void requestQuote();
    } else if (!view && quote && !steps.pay && now < quote.expiresAt && quote.policyPreview?.decision !== "refuse") {
      steps.pay = true;
      void startPayment();
    } else if (status === "AWAITING_SIGNATURE" && wallet.canSign && !steps.sign) {
      steps.sign = true;
      void signPayment();
    }
  });

  const quoteExpired = quote ? now >= quote.expiresAt : false;
  const refused = quote?.policyPreview?.decision === "refuse";
  const paid = status === "LEASE_ACTIVE" || status === "RECONCILED";
  const stopped = status !== null && TERMINAL_STATUSES.includes(status) && status !== "RECONCILED";
  const serverNow = now + clockOffset;

  return (
    <section ref={sectionRef} className="space-y-4 rounded-md border border-[#A5A79B]/25 bg-[#0D1B2E]/80 p-6 backdrop-blur-xl shadow-xl font-sans" aria-label="Rent this GPU">
      <div>
        <h2 className="text-lg font-bold text-[#FAF4EB] font-display">Rent {routed.offer.gpuModel}</h2>
        <p className="text-xs text-[#A5A79B]">
          {routed.offer.provider} · {routed.offer.vramGb} GB · ~{routed.estimatedDurationHours.toFixed(2)} h · estimated {usd(routed.estimatedTotalCostUsd)}
        </p>
      </div>

      {wallet.configError ? (
        <p className="rounded-sm border border-red-400/40 bg-red-900/30 p-3 text-xs text-red-100">{wallet.configError}</p>
      ) : (
        <SimulatedBanner config={config} />
      )}

      {!view && (
        <>
          {!wallet.account && (
            <p className="rounded-sm border border-[#E8D2B5]/40 bg-[#112540]/70 p-3 text-xs text-[#E8D2B5]">
              Connect a wallet in the navbar first. It pays for the lease, so it must be able to sign.
            </p>
          )}
          {wallet.account && walletMode && !wallet.canSign && (
            <p className="rounded-sm border border-[#E8D2B5]/40 bg-[#112540]/70 p-3 text-xs text-[#E8D2B5]">
              Every payment is signed in your wallet, and an account ID alone cannot sign. Connect HashPack or another Hedera wallet from the navbar.
            </p>
          )}

          {!quote && (
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <label className="block space-y-1">
                <span className="text-[11px] uppercase tracking-wider text-[#A5A79B] font-display">
                  Spending cap in USD (optional, default is the estimate plus a quarter)
                </span>
                <input
                  className="field"
                  type="number"
                  min={0}
                  step={0.01}
                  placeholder="Automatic"
                  value={capInput}
                  onChange={(e) => setCapInput(e.target.value)}
                />
              </label>
              <button
                type="button"
                className={button + " bg-[#E8D2B5] text-[#0B1728] hover:bg-[#FAF4EB]"}
                disabled={!canPay || busy !== null || Boolean(wallet.configError)}
                onClick={requestQuote}
              >
                {busy === "quote" ? "Pricing…" : "Get quote"}
              </button>
            </div>
          )}

          {quote && (
            <QuoteCard quote={quote} now={now}>
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  className={button + " bg-[#E8D2B5] text-[#0B1728] hover:bg-[#FAF4EB]"}
                  disabled={busy !== null || quoteExpired || refused}
                  onClick={startPayment}
                >
                  {busy === "pay" ? "Starting…" : walletMode ? "Continue to payment" : "Pay with the agent"}
                </button>
                <button
                  type="button"
                  className={button + " border border-[#A5A79B]/40 text-[#E8D2B5] hover:bg-[#112540]"}
                  disabled={busy !== null}
                  onClick={() => setQuote(null)}
                >
                  {quoteExpired ? "Get a new quote" : "Change the cap"}
                </button>
              </div>
            </QuoteCard>
          )}
        </>
      )}

      {view && (
        <div className="space-y-4">
          <Timeline steps={deriveSteps(view)} />

          {status === "PENDING_APPROVAL" && (
            <ApprovalCard
              view={view}
              now={now}
              mode={config?.approvalMode ?? "click"}
              canSign={wallet.canSign}
              busy={busy === "decide"}
              error={error}
              onApprove={() => void decide("approve")}
              onReject={() => void decide("reject")}
            />
          )}

          {status === "AWAITING_SIGNATURE" && (
            <SignCard view={view} now={now} terms={terms} canSign={wallet.canSign} busy={busy === "sign"} error={error} onSign={() => void signPayment()} />
          )}

          {status === "SIGNING" && walletMode && (
            <p className="rounded-sm border border-[#A5A79B]/25 bg-[#0B1728]/80 p-3 text-xs text-[#E8D2B5]">
              Signed. Submitting your payment to Hedera testnet and waiting for the network. This takes a few seconds.
            </p>
          )}

          {stopped && (
            <p className="rounded-sm border border-red-400/40 bg-red-900/30 p-3 text-sm text-red-100">
              {view.payment.status === "REFUSED" && "The payment was refused. "}
              {view.payment.status === "REJECTED" && "The payment was rejected. "}
              {view.payment.status === "EXPIRED" && "The payment expired. "}
              {view.payment.status === "FAILED" && "The payment failed. "}
              {view.payment.error}
              <span className="mt-1 block text-xs text-red-200">
                {view.payment.transactionId
                  ? "Check the transaction on HashScan to see whether any HBAR moved."
                  : "No HBAR was moved. The audit trail below shows exactly where it stopped."}
              </span>
            </p>
          )}

          {paid && <ReceiptCard view={view} config={config} />}

          {leaseRunning && <LeaseMeterCard view={view} serverNow={serverNow} busy={busy === "end"} onEnd={() => void endLease()} />}

          {status === "LEASE_ACTIVE" && !walletMode && (
            <div className="rounded-md border border-[#A5A79B]/25 bg-[#0B1728]/80 p-4">
              <p className="text-sm text-[#FAF4EB]">
                Your lease is active. Simulated development runs the lease as a simulation, billing by usage against your cap and returning what is unused.
              </p>
              <button type="button" className={button + " mt-3 bg-[#E8D2B5] text-[#0B1728] hover:bg-[#FAF4EB]"} disabled={busy !== null} onClick={() => void runSimulatedLease()}>
                {busy === "run" ? "Running…" : "Run the simulated lease and settle"}
              </button>
            </div>
          )}

          <ReconciliationCard view={view} />
          {receipt && <FinalReceiptCard receipt={receipt} />}
          <AuditTrail view={view} />

          {(stopped || status === "RECONCILED") && (
            <button type="button" className={button + " border border-[#A5A79B]/40 text-[#E8D2B5] hover:bg-[#112540]"} onClick={startOver}>
              Start over
            </button>
          )}
        </div>
      )}

      {error && status !== "PENDING_APPROVAL" && status !== "AWAITING_SIGNATURE" && (
        <p className="text-xs text-red-200" role="alert">{error}</p>
      )}
    </section>
  );
}
