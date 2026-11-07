import { AccountId, Hbar, TokenId, Transaction, TransactionId, TransferTransaction } from "@hiero-ledger/sdk";
import { proto } from "@hiero-ledger/proto";

/**
 * Builds the x402 payment the user's wallet signs.
 *
 * The x402 `exact` scheme on Hedera needs a partially signed TransferTransaction:
 *   - it moves the exact amount from the payer to the merchant,
 *   - its transaction ID names the FACILITATOR's fee-payer account, so the facilitator pays the fee,
 *   - it is signed only by the payer.
 *
 * A wallet signs through WalletConnect's hedera_signTransaction, which signs ONE transaction body and
 * returns ONE signature. The SDK's default node selection produces seven per-node copies of the
 * transaction, and one signature is invalid for six of them, so the official facilitator rejects the
 * payload as `signature_invalid`. The transfer must therefore be pinned to a single node. This was
 * tested against the official facilitator verification with a key standing in for the wallet.
 *
 * This module has no network access and imports nothing from the app, so the payment service's tests
 * run this exact code.
 */

/** Hedera testnet consensus nodes the transfer may be pinned to. */
export const TESTNET_NODE_ACCOUNTS = ["0.0.3", "0.0.4", "0.0.5", "0.0.6", "0.0.7", "0.0.8", "0.0.9"] as const;

/** The longest validity window the network allows for a transaction, in seconds. */
export const MAX_VALID_DURATION_SECONDS = 180;

export const HEDERA_TESTNET = "hedera:testnet";
export const HBAR_ASSET = "0.0.0";

export interface PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: { feePayer?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface PaymentRequired {
  x402Version: number;
  resource?: { url?: string; description?: string; mimeType?: string };
  accepts: PaymentRequirements[];
  [key: string]: unknown;
}

export interface PaymentPayload {
  x402Version: 2;
  resource?: PaymentRequired["resource"];
  accepted: PaymentRequirements;
  payload: { transaction: string };
}

/** What the user was shown and agreed to. The wallet is only asked to sign terms that match it. */
export interface ExpectedTerms {
  payTo: string;
  /** The amount in the asset's smallest unit: tinybars for HBAR, token base units for a token. */
  tinybars: string;
  /** The asset the user was quoted in. Omitted means native HBAR. */
  asset?: string;
}

export class PaymentBuildError extends Error {
  readonly code: "TERMS_MISMATCH" | "NO_TERMS" | "BAD_ACCOUNT" | "BAD_SIGNATURE";

  constructor(code: PaymentBuildError["code"], message: string) {
    super(message);
    this.name = "PaymentBuildError";
    this.code = code;
  }
}

const ACCOUNT = /^0\.0\.\d{1,12}$/;
const ASSET_ID = /^0\.0\.\d{1,12}$/;

/**
 * Picks the one payment option this app can sign, and refuses anything that differs from what the
 * user approved: network, asset, recipient, or amount. The wallet is never asked to sign terms the
 * user did not see.
 */
export function selectTerms(required: PaymentRequired, expected: ExpectedTerms): PaymentRequirements {
  const options = Array.isArray(required.accepts) ? required.accepts : [];
  const terms = options.find((o) => o.scheme === "exact" && o.network === HEDERA_TESTNET);
  if (!terms) throw new PaymentBuildError("NO_TERMS", "The server offered no payment option on Hedera testnet.");

  const problems: string[] = [];
  const asset = expected.asset ?? HBAR_ASSET;
  if (!ASSET_ID.test(asset)) problems.push(`the quoted asset ${asset} is not a valid asset`);
  if (terms.asset !== asset) problems.push(asset === HBAR_ASSET ? `asset ${terms.asset} is not native HBAR` : `asset ${terms.asset} is not the quoted token ${asset}`);
  if (terms.payTo !== expected.payTo) problems.push(`it pays ${terms.payTo}, not the merchant ${expected.payTo}`);
  if (String(terms.amount) !== String(expected.tinybars)) {
    problems.push(`it asks for ${terms.amount} units, not the quoted ${expected.tinybars}`);
  }
  const feePayer = terms.extra?.feePayer;
  if (typeof feePayer !== "string" || !ACCOUNT.test(feePayer)) problems.push("it names no valid fee payer");
  if (problems.length) {
    throw new PaymentBuildError("TERMS_MISMATCH", `The payment terms do not match your quote: ${problems.join("; ")}.`);
  }
  return terms;
}

function pickNode(random: () => number): string {
  return TESTNET_NODE_ACCOUNTS[Math.min(TESTNET_NODE_ACCOUNTS.length - 1, Math.floor(random() * TESTNET_NODE_ACCOUNTS.length))];
}

/**
 * Rewrites the transaction body in the canonical protobuf form, with no zero-valued fields written out.
 *
 * The SDK writes every account ID with explicit zero shard and realm fields. HashPack decodes the
 * transaction and signs its own re-encoding, which leaves those zeros out. The signature then covers
 * different bytes from the ones the facilitator checks, and the payment is rejected as signature_invalid
 * (found with a real HashPack: the signature verified only against the re-encoded body). Building the
 * transaction in canonical form first means the wallet and the facilitator sign and check identical bytes.
 */
export function canonicalizeTransaction<T extends Transaction>(tx: T): T {
  const list = proto.TransactionList.decode(tx.toBytes());
  const canonical = list.transactionList.map((entry) => {
    const signed = proto.SignedTransaction.decode(entry.signedTransactionBytes as Uint8Array);
    const body = proto.TransactionBody.decode(signed.bodyBytes);
    return {
      signedTransactionBytes: proto.SignedTransaction.encode({
        bodyBytes: proto.TransactionBody.encode(body).finish(),
        sigMap: signed.sigMap,
      }).finish(),
    };
  });
  return Transaction.fromBytes(proto.TransactionList.encode({ transactionList: canonical }).finish()) as T;
}

/**
 * The unsigned transfer, frozen and pinned to a single node. It is frozen with no network client,
 * because the transaction ID and the node are fixed here.
 */
export function buildPaymentTransaction(options: {
  terms: PaymentRequirements;
  payerAccountId: string;
  memo?: string;
  /** Pin to this node. Defaults to a random testnet node. */
  nodeAccountId?: string;
  random?: () => number;
}): TransferTransaction {
  const { terms, payerAccountId } = options;
  if (!ACCOUNT.test(payerAccountId)) throw new PaymentBuildError("BAD_ACCOUNT", "The connected account is not a valid Hedera account.");
  const feePayer = terms.extra?.feePayer;
  if (typeof feePayer !== "string") throw new PaymentBuildError("NO_TERMS", "The payment terms name no fee payer.");

  const amount = BigInt(terms.amount);
  if (amount <= BigInt(0)) throw new PaymentBuildError("TERMS_MISMATCH", "The payment amount must be above zero.");

  const nodeAccountId = options.nodeAccountId ?? pickNode(options.random ?? Math.random);
  const tx = new TransferTransaction();
  if (terms.asset === HBAR_ASSET) {
    tx.addHbarTransfer(AccountId.fromString(payerAccountId), Hbar.fromTinybars((-amount).toString()));
    tx.addHbarTransfer(AccountId.fromString(terms.payTo), Hbar.fromTinybars(amount.toString()));
  } else {
    // An HTS token: the same two-party transfer, in the token's base unit. Both accounts must be
    // associated with the token. The fee is still paid by the facilitator, in HBAR.
    if (!ASSET_ID.test(terms.asset)) throw new PaymentBuildError("TERMS_MISMATCH", "The payment asset is not a valid token.");
    const token = TokenId.fromString(terms.asset);
    tx.addTokenTransfer(token, AccountId.fromString(payerAccountId), -amount);
    tx.addTokenTransfer(token, AccountId.fromString(terms.payTo), amount);
  }
  tx
    .setTransactionId(TransactionId.generate(AccountId.fromString(feePayer)))
    .setNodeAccountIds([AccountId.fromString(nodeAccountId)])
    .setTransactionValidDuration(MAX_VALID_DURATION_SECONDS);
  if (options.memo) tx.setTransactionMemo(options.memo.slice(0, 100));
  tx.freeze();
  return canonicalizeTransaction(tx);
}

/** Base64 that works in the browser, with no Node Buffer. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/**
 * Builds the transfer, has the wallet sign it, and returns the x402 payment payload.
 *
 * `signTransaction` is the wallet. With HashPack it is the WalletConnect signer's signTransaction,
 * which asks the user to approve the transfer and returns it with their signature added.
 */
export async function createSignedPayment(options: {
  required: PaymentRequired;
  expected: ExpectedTerms;
  payerAccountId: string;
  memo?: string;
  signTransaction: (tx: TransferTransaction) => Promise<Transaction>;
  nodeAccountId?: string;
  random?: () => number;
}): Promise<{ payload: PaymentPayload; nodeAccountId: string; transactionId: string }> {
  const terms = selectTerms(options.required, options.expected);
  const tx = buildPaymentTransaction({
    terms,
    payerAccountId: options.payerAccountId,
    memo: options.memo,
    nodeAccountId: options.nodeAccountId,
    random: options.random,
  });
  const nodeAccountId = tx.nodeAccountIds?.[0]?.toString() ?? "";
  const transactionId = tx.transactionId?.toString() ?? "";

  const signed = await options.signTransaction(tx);
  const bytes = signed.toBytes();
  if (!bytes || bytes.length === 0) throw new PaymentBuildError("BAD_SIGNATURE", "The wallet returned an empty transaction.");

  return {
    payload: {
      x402Version: 2,
      resource: options.required.resource,
      accepted: terms,
      payload: { transaction: bytesToBase64(bytes) },
    },
    nodeAccountId,
    transactionId,
  };
}
