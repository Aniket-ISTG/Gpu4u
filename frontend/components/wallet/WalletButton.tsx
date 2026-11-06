"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet } from "./WalletProvider";

const shorten = (id: string) => id;

/** The wallet control in the navbar: connect, see the account, disconnect. */
export default function WalletButton() {
  const wallet = useWallet();
  const [openedFor, setOpenedFor] = useState<{ account: string | null } | null>(null);
  const open = openedFor !== null && openedFor.account === wallet.account;
  const [manual, setManual] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpenedFor(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpenedFor(open ? null : { account: wallet.account })}
        className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-display font-bold transition-colors ${
          wallet.account
            ? "border-[#E8D2B5]/40 bg-[#1E3A5F]/80 text-[#E8D2B5] hover:bg-[#23477A]"
            : "border-[#E8D2B5] bg-[#E8D2B5] text-[#0B1728] hover:bg-[#FAF4EB]"
        }`}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        {wallet.account ? (
          <>
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            <span className="font-mono">{shorten(wallet.account)}</span>
          </>
        ) : (
          <span>Connect wallet</span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Wallet"
          className="absolute right-0 z-50 mt-2 w-80 space-y-3 rounded-md border border-[#A5A79B]/30 bg-[#0B1728] p-4 shadow-2xl font-sans"
        >
          {wallet.account ? (
            <>
              <div className="text-xs text-[#A5A79B]">
                <p className="font-display uppercase tracking-wider text-[#E8D2B5]">Connected</p>
                <p className="mt-1 font-mono text-sm text-[#FAF4EB]">{wallet.account}</p>
                <p className="mt-1">
                  Hedera testnet ·{" "}
                  {wallet.canSign ? "can sign approvals" : "account only, cannot sign approvals"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void wallet.disconnect()}
                className="w-full rounded-sm border border-[#A5A79B]/40 px-3 py-2 text-xs font-display font-bold text-[#E8D2B5] hover:bg-[#112540]"
              >
                Disconnect
              </button>
            </>
          ) : (
            <>
              <div>
                <p className="text-xs font-display font-bold uppercase tracking-wider text-[#E8D2B5]">Connect a wallet</p>
                <p className="mt-1 text-xs text-[#A5A79B]">
                  Your wallet identifies you and signs approvals for larger payments. It never holds the agent&apos;s funds.
                </p>
              </div>

              <button
                type="button"
                disabled={!wallet.walletConnectAvailable || wallet.status === "connecting"}
                onClick={() => void wallet.connectWalletConnect()}
                className="w-full rounded-sm bg-[#E8D2B5] px-3 py-2 text-xs font-display font-bold text-[#0B1728] hover:bg-[#FAF4EB] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {wallet.status === "connecting" ? "Connecting…" : "HashPack or another Hedera wallet"}
              </button>
              {!wallet.walletConnectAvailable && (
                <p className="text-[11px] text-[#A5A79B]">
                  Wallet connection is not set up on this server. An operator must set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID.
                </p>
              )}

              {wallet.paymentConfig && !wallet.paymentConfig.simulated ? (
                <p className="border-t border-[#A5A79B]/20 pt-3 text-[11px] text-[#A5A79B]">
                  This server settles on Hedera testnet. Every payment is signed in your wallet, so an account ID alone cannot be used.
                </p>
              ) : (
              <form
                className="space-y-2 border-t border-[#A5A79B]/20 pt-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void wallet.connectManual(manual);
                }}
              >
                <label className="block text-[11px] uppercase tracking-wider text-[#A5A79B] font-display" htmlFor="manual-account">
                  Or use a testnet account ID
                </label>
                <input
                  id="manual-account"
                  className="field font-mono"
                  placeholder="0.0.1234"
                  value={manual}
                  onChange={(event) => setManual(event.target.value)}
                  inputMode="numeric"
                  autoComplete="off"
                />
                <button
                  type="submit"
                  disabled={wallet.status === "connecting" || !/^0\.0\.\d+$/.test(manual.trim())}
                  className="w-full rounded-sm border border-[#E8D2B5]/40 bg-[#112540] px-3 py-2 text-xs font-display font-bold text-[#E8D2B5] hover:bg-[#18335A] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Use this account
                </button>
                <p className="text-[11px] text-[#A5A79B]">
                  An account ID alone cannot sign, so approvals can only be given by a click and not a signature.
                </p>
              </form>
              )}
            </>
          )}
          {wallet.error && <p className="text-xs text-[#E8D2B5]">{wallet.error}</p>}
        </div>
      )}
    </div>
  );
}
