"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { apiRequest, ApiError } from "@/lib/payments/api";
import type { PaymentConfig, PaymentRequirementsResponse } from "@/lib/payments/types";
import type { PaymentPayload } from "@/lib/payments/payment-transaction";

export type WalletSource = "walletconnect" | "manual";

interface WalletContextValue {
  /** The connected Hedera testnet account, or null. */
  account: string | null;
  source: WalletSource | null;
  status: "idle" | "connecting";
  error: string | null;
  /** True when a WalletConnect project ID is configured, so a real wallet can connect. */
  walletConnectAvailable: boolean;
  /** True when the connected wallet can sign approval messages. */
  canSign: boolean;
  connectWalletConnect: () => Promise<void>;
  connectManual: (accountId: string) => Promise<void>;
  disconnect: () => Promise<void>;
  /** Asks the wallet to sign a message. Returns the base64 signature map. */
  signMessage: (message: string) => Promise<string>;
  /**
   * Builds the exact x402 payment and asks the connected wallet to sign it. The wallet shows the user the
   * transfer. Throws a clear error, and nothing is paid, if the user rejects it.
   */
  signPayment: (terms: PaymentRequirementsResponse) => Promise<{ payload: PaymentPayload; nodeAccountId: string; transactionId: string }>;
  /** What the payment service is configured for, or null until it answers. */
  paymentConfig: PaymentConfig | null;
  configError: string | null;
}

const WalletContext = createContext<WalletContextValue | null>(null);

const STORAGE_KEY = "gpu4u.wallet";
const PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

interface Stored {
  account: string;
  source: WalletSource;
}

// The remembered wallet lives in storage, read through useSyncExternalStore so the page renders the
// same on the server and the first client pass, then updates. If storage is blocked the choice is
// kept in memory for the session instead.
const listeners = new Set<() => void>();
let memoryRaw: string | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return memoryRaw;
  }
}

function writeStored(value: Stored | null) {
  memoryRaw = value ? JSON.stringify(value) : null;
  try {
    if (memoryRaw) window.localStorage.setItem(STORAGE_KEY, memoryRaw);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage is blocked; the memory copy above still works for this session */
  }
  listeners.forEach((listener) => listener());
}

function parseStored(raw: string | null): Stored | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Stored;
    return /^0\.0\.\d+$/.test(parsed.account) && (parsed.source === "walletconnect" || parsed.source === "manual") ? parsed : null;
  } catch {
    return null;
  }
}

type Connector = {
  init: (options?: { logger?: string }) => Promise<void>;
  openModal: () => Promise<unknown>;
  disconnectAll: () => Promise<void>;
  signers: { getAccountId: () => { toString: () => string } }[];
  signMessage: (params: { signerAccountId: string; message: string }) => Promise<unknown>;
  getSigner: (accountId: unknown) => { signTransaction: (tx: unknown) => Promise<{ toBytes: () => Uint8Array }> };
};

/** A wallet that declines to sign says so in many different ways. */
function looksLikeRejection(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /reject|denied|declin|cancel|user (closed|abort)|5000|4001/i.test(text);
}

/** The wallet connection for the whole app. The account is public, so it is safe to remember. */
export function WalletProvider({ children }: { children: ReactNode }) {
  const raw = useSyncExternalStore(subscribe, readRaw, () => null);
  const stored = useMemo(() => parseStored(raw), [raw]);
  const account = stored?.account ?? null;
  const source = stored?.source ?? null;

  const [status, setStatus] = useState<"idle" | "connecting">("idle");
  const [error, setError] = useState<string | null>(null);
  const [paymentConfig, setPaymentConfig] = useState<PaymentConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const connectorRef = useRef<Promise<Connector> | null>(null);

  /** Builds the WalletConnect client once. It is loaded on demand because it only runs in a browser. */
  const getConnector = useCallback((): Promise<Connector> => {
    if (!PROJECT_ID) return Promise.reject(new Error("WalletConnect is not configured. Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID."));
    if (!connectorRef.current) {
      connectorRef.current = (async () => {
        const [{ DAppConnector, HederaJsonRpcMethod, HederaSessionEvent, HederaChainId }, { LedgerId }] = await Promise.all([
          import("@hashgraph/hedera-wallet-connect"),
          import("@hiero-ledger/sdk"),
        ]);
        const connector = new DAppConnector(
          {
            name: "GPU4U",
            description: "Find the best GPU for your task and pay for it with an x402 agent on Hedera.",
            url: window.location.origin,
            icons: [window.location.origin + "/favicon.ico"],
          },
          LedgerId.TESTNET,
          PROJECT_ID,
          Object.values(HederaJsonRpcMethod),
          [HederaSessionEvent.ChainChanged, HederaSessionEvent.AccountsChanged],
          [HederaChainId.Testnet],
        );
        await connector.init({ logger: "error" });
        return connector as unknown as Connector;
      })().catch((e) => {
        connectorRef.current = null;
        throw e;
      });
    }
    return connectorRef.current;
  }, []);

  // The payment service says whether this is simulated development or real testnet, and who pays.
  useEffect(() => {
    let cancelled = false;
    apiRequest<PaymentConfig>("GET", "/api/payments/config")
      .then((config) => !cancelled && setPaymentConfig(config))
      .catch((e) => !cancelled && setConfigError(e instanceof ApiError ? e.message : "The payment service is not reachable."));
    return () => {
      cancelled = true;
    };
  }, []);

  // A remembered WalletConnect session is only kept if the wallet still has it.
  useEffect(() => {
    if (!stored || stored.source !== "walletconnect") return;
    let cancelled = false;
    getConnector()
      .then((connector) => {
        if (cancelled) return;
        const live = connector.signers.some((s) => s.getAccountId().toString() === stored.account);
        if (!live) writeStored(null);
      })
      .catch(() => writeStored(null));
    return () => {
      cancelled = true;
    };
  }, [stored, getConnector]);

  const connectWalletConnect = useCallback(async () => {
    setError(null);
    setStatus("connecting");
    try {
      const connector = await getConnector();
      await connector.openModal();
      const signer = connector.signers[connector.signers.length - 1];
      if (!signer) throw new Error("No account was shared by the wallet.");
      writeStored({ account: signer.getAccountId().toString(), source: "walletconnect" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect the wallet.");
    } finally {
      setStatus("idle");
    }
  }, [getConnector]);

  const connectManual = useCallback(async (accountId: string) => {
    setError(null);
    if (paymentConfig && !paymentConfig.simulated) {
      setError("On Hedera testnet every payment is signed in your wallet, so an account ID alone cannot be used. Connect a wallet.");
      return;
    }
    setStatus("connecting");
    try {
      const resolved = await apiRequest<{ account: string }>("GET", "/api/wallet/resolve?account=" + encodeURIComponent(accountId.trim()));
      writeStored({ account: resolved.account, source: "manual" });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not check that account.");
    } finally {
      setStatus("idle");
    }
  }, [paymentConfig]);

  const disconnect = useCallback(async () => {
    setError(null);
    if (source === "walletconnect" && connectorRef.current) {
      try {
        await (await connectorRef.current).disconnectAll();
      } catch {
        /* the session may already be gone */
      }
    }
    writeStored(null);
  }, [source]);

  const signMessage = useCallback(
    async (message: string): Promise<string> => {
      if (source !== "walletconnect" || !account) {
        throw new Error("Connect a wallet that can sign to approve this payment.");
      }
      const connector = await getConnector();
      const response = (await connector.signMessage({ signerAccountId: "hedera:testnet:" + account, message })) as {
        signatureMap?: string;
        result?: { signatureMap?: string };
      };
      const signatureMap = response?.signatureMap ?? response?.result?.signatureMap;
      if (!signatureMap) throw new Error("The wallet did not return a signature.");
      return signatureMap;
    },
    [source, account, getConnector],
  );

  const signPayment = useCallback(
    async (terms: PaymentRequirementsResponse) => {
      if (source !== "walletconnect" || !account) {
        throw new Error("Connect a wallet that can sign to pay. An account ID alone cannot sign.");
      }
      if (terms.wallet !== account) {
        throw new Error(`This payment is for account ${terms.wallet}, but your connected account is ${account}. Connect the right account.`);
      }
      const [{ createSignedPayment }, { AccountId }, connector] = await Promise.all([
        import("@/lib/payments/payment-transaction"),
        import("@hiero-ledger/sdk"),
        getConnector(),
      ]);
      const signer = connector.getSigner(AccountId.fromString(account));
      try {
        return await createSignedPayment({
          required: terms.required,
          expected: terms.expected,
          payerAccountId: account,
          memo: terms.memo,
          // The wallet shows the user the transfer, and returns it with their signature added.
          signTransaction: (tx) => signer.signTransaction(tx) as ReturnType<Parameters<typeof createSignedPayment>[0]["signTransaction"]>,
        });
      } catch (e) {
        if (looksLikeRejection(e)) throw new Error("You rejected the signature in your wallet. Nothing was paid.");
        throw e;
      }
    },
    [source, account, getConnector],
  );

  const value = useMemo<WalletContextValue>(
    () => ({
      account,
      source,
      status,
      error,
      walletConnectAvailable: Boolean(PROJECT_ID),
      canSign: source === "walletconnect",
      connectWalletConnect,
      connectManual,
      disconnect,
      signMessage,
      signPayment,
      paymentConfig,
      configError,
    }),
    [account, source, status, error, connectWalletConnect, connectManual, disconnect, signMessage, signPayment, paymentConfig, configError],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext);
  if (!context) throw new Error("useWallet must be used inside WalletProvider");
  return context;
}
