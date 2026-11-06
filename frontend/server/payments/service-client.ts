import type { PaymentConfig, PaymentRequirementsResponse, PaymentView, Quote, Receipt } from "../../lib/payments/types.ts";
import type { ServiceQuoteRequest } from "./quote-builder.ts";

export class PaymentServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "PaymentServiceError";
    this.status = status;
    this.code = code;
  }
}

export interface PaymentServiceOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Reads the connection settings from the environment. The token never leaves the server. */
export function paymentServiceOptionsFromEnv(env: Record<string, string | undefined> = process.env): PaymentServiceOptions {
  const token = env.PAYMENT_SERVICE_TOKEN;
  if (!token || token.length < 16) {
    throw new PaymentServiceError(
      503,
      "NOT_CONFIGURED",
      "Payments are not configured on this server. Set PAYMENT_SERVICE_TOKEN to the same value as the payment service.",
    );
  }
  return { baseUrl: (env.PAYMENT_SERVICE_URL || "http://127.0.0.1:4021").replace(/\/$/, ""), token };
}

/**
 * Talks to the payment service from the web app's server. The browser never calls the payment
 * service: it calls this app's API routes, which call the service with a secret token.
 */
export class PaymentServiceClient {
  private readonly options: PaymentServiceOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PaymentServiceOptions) {
    this.options = { ...options, baseUrl: options.baseUrl.replace(/\/+$/, "") };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown, authenticated = true): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.baseUrl + path, {
        method,
        headers: {
          "content-type": "application/json",
          ...(authenticated ? { authorization: "Bearer " + this.options.token } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
        cache: "no-store",
      });
    } catch {
      throw new PaymentServiceError(503, "SERVICE_UNAVAILABLE", "The payment service is not reachable. Make sure it is running.");
    }

    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!response.ok) {
      const error = json as { error?: string; message?: string } | null;
      throw new PaymentServiceError(response.status, error?.error ?? "SERVICE_ERROR", error?.message ?? "The payment service returned an error.");
    }
    return json as T;
  }

  getConfig(): Promise<PaymentConfig> {
    return this.request<PaymentConfig>("GET", "/v1/config", undefined, false);
  }

  createQuote(body: ServiceQuoteRequest): Promise<Quote> {
    return this.request<Quote>("POST", "/v1/quotes", body);
  }

  startPayment(quoteId: string): Promise<PaymentView> {
    return this.request<PaymentView>("POST", "/v1/payments", { quoteId });
  }

  getPayment(paymentId: string): Promise<PaymentView> {
    return this.request<PaymentView>("GET", "/v1/payments/" + encodeURIComponent(paymentId));
  }

  decideApproval(
    approvalId: string,
    body: { decision: "approve" | "reject"; wallet: string; signatureMap?: string },
  ): Promise<PaymentView> {
    return this.request<PaymentView>("POST", "/v1/approvals/" + encodeURIComponent(approvalId) + "/decision", body);
  }

  getRequirements(paymentId: string): Promise<PaymentRequirementsResponse> {
    return this.request<PaymentRequirementsResponse>("GET", "/v1/payments/" + encodeURIComponent(paymentId) + "/requirements");
  }

  submitSigned(paymentId: string, paymentPayload: unknown): Promise<PaymentView> {
    return this.request<PaymentView>("POST", "/v1/payments/" + encodeURIComponent(paymentId) + "/submit", { paymentPayload });
  }

  endLease(paymentId: string): Promise<PaymentView> {
    return this.request<PaymentView>("POST", "/v1/payments/" + encodeURIComponent(paymentId) + "/lease/end", {});
  }


  getReceipt(paymentId: string): Promise<Receipt> {
    return this.request<Receipt>("GET", "/v1/payments/" + encodeURIComponent(paymentId) + "/receipt");
  }

  completeLease(
    paymentId: string,
    body: { actualUsd: number; actualDurationHours: number; status: "completed" | "stopped_at_cap"; run?: unknown },
  ): Promise<PaymentView> {
    return this.request<PaymentView>("POST", "/v1/payments/" + encodeURIComponent(paymentId) + "/lease/complete", body);
  }
}
