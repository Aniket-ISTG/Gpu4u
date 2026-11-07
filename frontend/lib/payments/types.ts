/**
 * Shapes returned by the payment service, as the web app sees them. The browser only ever
 * receives these through the app's own /api routes, never from the payment service directly.
 */

export type PaymentStatus =
  | "RECEIVED"
  | "POLICY_CHECKED"
  | "REFUSED"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED"
  | "AWAITING_SIGNATURE"
  | "AWAITING_402"
  | "SIGNING"
  | "SUBMITTED"
  | "CONFIRMED"
  | "LEASE_ACTIVE"
  | "RECONCILED"
  | "FAILED";

export const TERMINAL_STATUSES: readonly PaymentStatus[] = [
  "REFUSED",
  "REJECTED",
  "EXPIRED",
  "FAILED",
  "RECONCILED",
];

export interface PolicyPreview {
  decision: "auto" | "approval" | "refuse";
  reasons: string[];
  limits: {
    autoApproveLimitUsd: number;
    dailyLimitUsd: number;
    hardCeilingUsd: number;
    globalDailyLimitUsd?: number;
  };
  committedTodayUsd: number;
  remainingDailyUsd: number;
}

export interface Quote {
  id: string;
  createdAt: number;
  expiresAt: number;
  wallet: string;
  payTo: string;
  offer: {
    id: string;
    provider: string;
    gpuModel: string;
    gpuCount: number;
    vramGb: number;
    region: string;
  };
  providerEntry?: {
    id: string;
    mock: boolean;
    provider: string;
    offerId: string;
    gpuModel: string;
    gpuCount: number;
    region: string;
    hourlyUsd: number;
    receiverAccountId: string;
    receiverSource: string;
  };
  hours: number;
  hourlyUsd: number;
  estimateUsd: number;
  capUsd: number;
  /** The amount in the asset's smallest unit: tinybars for HBAR, token base units for a token. */
  tinybars: string;
  /** What the quote is paid in. HBAR, or an HTS token such as USDC. */
  asset: { id: string; symbol: string; decimals: number; native: boolean; unit: string };
  /** The amount in the asset's own units, ready to show, such as "0.42". */
  amountDisplay: string;
  assetSymbol: string;
  /** The amount in HBAR. Null when the quote is not in HBAR. */
  hbar: string | null;
  rate: {
    /** Null when the quote is in a $1 token, which needs no exchange rate. */
    usdPerHbar: number | null;
    source: string;
    validUntil: number;
  };
  termsHash: string;
  status: string;
  expired?: boolean;
  policyPreview?: PolicyPreview;
}

export interface Approval {
  id: string;
  paymentId: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
  message: string;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  method: string | null;
  consumed: boolean;
}

/** Where a person can check a transaction on the public ledger. Null for simulated payments. */
export interface LedgerLinks {
  /** The HashScan explorer page. */
  hashscan: string | null;
  /** The mirror node record, a JSON document anyone can fetch and compare. */
  mirrorApi: string | null;
}

export interface Settlement {
  verified?: boolean;
  settled?: boolean;
  status?: string;
  transactionId?: string;
  consensusTimestamp?: string;
  feePayer?: string;
  payer?: string;
  explorerUrl?: string | null;
  problems?: string[];
}

export interface Payment {
  id: string;
  quoteId: string;
  wallet: string;
  status: PaymentStatus;
  createdAt: number;
  updatedAt: number;
  decision: "auto" | "approval" | "refuse" | null;
  decisionReasons: string[];
  capUsd: number;
  tinybars: string;
  transactionId: string | null;
  settlement: Settlement | null;
  error: string | null;
  mode: "simulated" | "testnet";
}

export interface Reconciliation {
  paidTinybars: string;
  billedTinybars: string;
  paidHbar: string | null;
  billedHbar: string | null;
  paidDisplay: string;
  billedDisplay: string;
  asset: Quote["asset"];
  capUsd: number;
  estimateUsd: number;
  actualUsd: number;
  actualDurationHours: number;
  estimatedDurationHours: number;
  deltaVsEstimateUsd: number;
  runStatus: "completed" | "stopped_at_cap";
  /** "lease-time": billed for the time the lease was held. "simulated": a simulated run. */
  billingBasis: "lease-time" | "simulated";
  billingNote: string;
  simulatedRun: boolean;
}

export interface Lease {
  id: string;
  paymentId: string;
  /** Epoch milliseconds when the lease started and its clock began. */
  createdAt: number;
  status: "ACTIVE" | "ENDING" | "RECONCILED";
  offer: Quote["offer"] & { hours: number; simulated: boolean };
  run: { source?: string; billedSeconds?: number; capSeconds?: number; elapsedSeconds?: number } | null;
  reconciliation: Reconciliation | null;
}

export interface AuditEvent {
  seq: number;
  eventType: string;
  status: string;
  transactionId: string | null;
  createdAt: string;
  details: Record<string, unknown>;
  hash: string;
  prevHash: string;
  hcs: { status: "LOCAL" | "PENDING" | "PUBLISHED" | "CONFIRMED" | "UNCONFIRMED" | "MISMATCH" | "FAILED"; sequence: string | null; consensusTimestamp?: string | null };
}

export interface PaymentView {
  payment: Payment;
  quote: Quote;
  approval: Approval | null;
  lease: Lease | null;
  events: AuditEvent[];
  chain: { valid: boolean; brokenAtSeq: number | null };
  /** Ledger links for each transaction. All null when the payment was simulated. */
  links: { payment: LedgerLinks; topic: LedgerLinks; wallet: { hashscan: string | null } };
  /** "wallet": the user's wallet signed the payment. "agent": a server key paid (simulated development only). */
  payerMode: "wallet" | "agent";
  /** The payment service's clock, in epoch milliseconds, for lease timing. */
  serverTime: number;
}

export interface PaymentConfig {
  mode: "simulated" | "testnet";
  simulated: boolean;
  network: string;
  /** "wallet": the user's wallet signs every payment. "agent": a server key pays (simulated development only). */
  payer: "wallet" | "agent";
  accounts: { agent: string | null; merchant: string; feePayer: string | null };
  facilitator: { mode: "local" | "external"; feePayer: string | null };
  explorer: { hashscan: string; mirror: string } | null;
  limits: { autoApproveLimitUsd: number; dailyLimitUsd: number; hardCeilingUsd: number; globalDailyLimitUsd: number };
  approvalMode: "click" | "wallet";
  approvalTtlSeconds: number;
  quoteTtlSeconds: number;
  hcsTopicId: string | null;
}

/** What the quote endpoint returns to the browser. */
export interface QuoteResponse {
  quote: Quote;
}

/** The x402 terms the wallet is asked to sign, and what the user was quoted. */
export interface PaymentRequirementsResponse {
  paymentId: string;
  required: {
    x402Version: number;
    resource?: { url?: string; description?: string; mimeType?: string };
    accepts: {
      scheme: string;
      network: string;
      amount: string;
      asset: string;
      payTo: string;
      maxTimeoutSeconds?: number;
      extra?: { feePayer?: string };
    }[];
  };
  expected: { payTo: string; tinybars: string; asset: string };
  wallet: string;
  memo: string;
  expiresAt: number;
}

/** The final receipt for a payment. */
export interface Receipt {
  receiptVersion: number;
  generatedAt: string;
  complete: boolean;
  status: PaymentStatus;
  mode: "simulated" | "testnet";
  simulated: boolean;
  network: string;
  payer: { wallet: string; mode: "wallet" | "agent" };
  merchant: string;
  offer: Quote["offer"];
  quote: { id: string; estimateUsd: number; capUsd: number; hourlyUsd: number; paidTinybars: string; paidHbar: string | null; paidDisplay: string; asset: Quote["asset"] };
  payment: {
    transactionId: string | null;
    consensusTimestamp: string | null;
    feePayer: string | null;
    verifiedOnLedger: boolean;
    links: LedgerLinks;
  };
  lease: {
    id: string;
    status: Lease["status"];
    startedAt: string;
    billingBasis: "lease-time" | "simulated" | null;
    billingNote: string | null;
    billedHbar: string | null;
    billedDisplay: string | null;
    billedUsd: number | null;
    billedSeconds: number | null;
    runStatus: "completed" | "stopped_at_cap" | null;
  } | null;
  refund: { policy: "none"; note: string };
  audit: {
    events: number;
    chainIntact: boolean;
    anchors: { published: number; confirmed: number; failed: number; local: number };
    topic: { id: string | null; links: LedgerLinks };
  };
}
