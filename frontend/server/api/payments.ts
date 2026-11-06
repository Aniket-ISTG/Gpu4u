import { z } from "zod";
import { getMarketplaceProvider } from "../marketplace/aquanode-provider";
import {
  PaymentServiceClient,
  PaymentServiceError,
  paymentServiceOptionsFromEnv,
} from "../payments/service-client";
import { QuoteBuildError, QuoteBuildRequestSchema, buildQuoteRequest } from "../payments/quote-builder";
import { planLeaseRun } from "../payments/lease-run";

const PAYMENT_ID = /^pay_[0-9a-f]{24}$/;
const APPROVAL_ID = /^appr_[0-9a-f]{24}$/;
const QUOTE_ID = /^q_[0-9a-f]{24}$/;

class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequest";
  }
}

const client = () => new PaymentServiceClient(paymentServiceOptionsFromEnv());

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new BadRequest("Request body must be valid JSON.");
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof PaymentServiceError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof QuoteBuildError) {
    return Response.json(
      { error: error.code, message: error.message, details: error.details },
      { status: error.code === "PRICE_CHANGED" ? 409 : 422 },
    );
  }
  if (error instanceof z.ZodError) {
    return Response.json(
      {
        error: "VALIDATION_FAILED",
        message: "The request is not valid.",
        issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
      { status: 400 },
    );
  }
  if (error instanceof BadRequest) {
    return Response.json({ error: "BAD_REQUEST", message: error.message }, { status: 400 });
  }
  console.error("[payments] unexpected error:", error);
  return Response.json({ error: "INTERNAL", message: "Something went wrong." }, { status: 500 });
}

function checkId(id: string, pattern: RegExp, label: string) {
  if (!pattern.test(id)) throw new BadRequest(`Not a valid ${label} ID.`);
}

/** GET /api/payments/config: limits, accounts and mode, so the page can explain what will happen. */
export async function handleGetConfig(): Promise<Response> {
  try {
    return Response.json(await client().getConfig());
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/quotes: turns a chosen GPU into a priced quote. The price is recomputed here from live
 * marketplace data and the user's workload. The browser sends no price.
 */
export async function handleCreateQuote(request: Request): Promise<Response> {
  try {
    const body = QuoteBuildRequestSchema.parse(await readJson(request));
    const snapshot = await getMarketplaceProvider().getSnapshot();
    const built = buildQuoteRequest(body, snapshot.offers);
    const quote = await client().createQuote(built);
    return Response.json({ quote }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

const StartSchema = z.object({ quoteId: z.string().regex(QUOTE_ID) }).strict();

/** POST /api/payments: starts the policy check and, if allowed, the agent's x402 payment. */
export async function handleStartPayment(request: Request): Promise<Response> {
  try {
    const { quoteId } = StartSchema.parse(await readJson(request));
    return Response.json(await client().startPayment(quoteId), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

/** GET /api/payments/:id: the payment, its quote, approval, lease and audit trail. */
export async function handleGetPayment(paymentId: string): Promise<Response> {
  try {
    checkId(paymentId, PAYMENT_ID, "payment");
    return Response.json(await client().getPayment(paymentId));
  } catch (error) {
    return errorResponse(error);
  }
}

const DecisionSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    wallet: z.string().regex(/^0\.0\.\d+$/),
    signatureMap: z.string().max(8192).optional(),
  })
  .strict();

/** POST /api/approvals/:id/decision: a person approves or rejects a held payment. */
export async function handleDecision(approvalId: string, request: Request): Promise<Response> {
  try {
    checkId(approvalId, APPROVAL_ID, "approval");
    const body = DecisionSchema.parse(await readJson(request));
    return Response.json(await client().decideApproval(approvalId, body));
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/payments/:id/run: runs the simulated lease and reconciles it. Billing is by actual
 * usage against the cap that was paid, and anything unused is returned.
 */
export async function handleRunLease(paymentId: string): Promise<Response> {
  try {
    checkId(paymentId, PAYMENT_ID, "payment");
    const service = client();
    const view = await service.getPayment(paymentId);
    if (view.payment.status === "RECONCILED") return Response.json(view);
    if (view.payment.status !== "LEASE_ACTIVE") {
      return Response.json(
        { error: "NOT_ACTIVE", message: `There is no active lease to run. The payment is ${view.payment.status}.` },
        { status: 409 },
      );
    }
    const plan = planLeaseRun(view);
    return Response.json(
      await service.completeLease(paymentId, {
        actualUsd: plan.actualUsd,
        actualDurationHours: plan.actualDurationHours,
        status: plan.status,
        run: plan.run,
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

/** GET /api/payments/:id/requirements: the exact x402 terms the user's wallet will be asked to sign. */
export async function handleGetRequirements(paymentId: string): Promise<Response> {
  try {
    checkId(paymentId, PAYMENT_ID, "payment");
    return Response.json(await client().getRequirements(paymentId));
  } catch (error) {
    return errorResponse(error);
  }
}

// The payment service checks the signed payment in detail. This only keeps the shape and size sane.
const SubmitSchema = z
  .object({
    paymentPayload: z
      .object({
        x402Version: z.literal(2),
        resource: z.record(z.string(), z.unknown()).optional(),
        accepted: z.record(z.string(), z.unknown()),
        payload: z.object({ transaction: z.string().min(1).max(20_000) }).strict(),
      })
      .strict(),
  })
  .strict();

/** POST /api/payments/:id/submit: relays the payment the user's wallet signed. */
export async function handleSubmitSigned(paymentId: string, request: Request): Promise<Response> {
  try {
    checkId(paymentId, PAYMENT_ID, "payment");
    const body = SubmitSchema.parse(await readJson(request));
    return Response.json(await client().submitSigned(paymentId, body.paymentPayload));
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/payments/:id/end: ends the lease and bills the time it was held. */
export async function handleEndLease(paymentId: string): Promise<Response> {
  try {
    checkId(paymentId, PAYMENT_ID, "payment");
    return Response.json(await client().endLease(paymentId));
  } catch (error) {
    return errorResponse(error);
  }
}

/** GET /api/payments/:id/receipt: the final receipt, with a ledger link for each transaction. */
export async function handleGetReceipt(paymentId: string): Promise<Response> {
  try {
    checkId(paymentId, PAYMENT_ID, "payment");
    return Response.json(await client().getReceipt(paymentId));
  } catch (error) {
    return errorResponse(error);
  }
}

const MIRROR_URL = () => (process.env.HEDERA_MIRROR_URL || "https://testnet.mirrornode.hedera.com").replace(/\/$/, "");

/** GET /api/wallet/resolve?account=0.0.x: confirms an account exists on Hedera testnet. */
export async function handleResolveAccount(request: Request): Promise<Response> {
  try {
    const account = new URL(request.url).searchParams.get("account") ?? "";
    if (!/^0\.0\.\d{1,12}$/.test(account)) throw new BadRequest("Enter an account ID like 0.0.1234.");

    let response: Response;
    try {
      response = await fetch(`${MIRROR_URL()}/api/v1/accounts/${account}`, {
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
      });
    } catch {
      return Response.json(
        { error: "MIRROR_UNAVAILABLE", message: "Could not reach the Hedera testnet to check this account." },
        { status: 503 },
      );
    }
    if (response.status === 404) {
      return Response.json({ error: "NOT_FOUND", message: "That account does not exist on Hedera testnet." }, { status: 404 });
    }
    if (!response.ok) {
      return Response.json({ error: "MIRROR_ERROR", message: "The Hedera testnet could not look up this account." }, { status: 502 });
    }
    const body = (await response.json()) as {
      account: string;
      key?: { _type?: string };
      balance?: { balance?: number };
      receiver_sig_required?: boolean;
    };
    return Response.json({
      account: body.account,
      network: "hedera:testnet",
      keyType: body.key?._type ?? "UNKNOWN",
      balanceHbar: (body.balance?.balance ?? 0) / 100_000_000,
      receiverSigRequired: Boolean(body.receiver_sig_required),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
