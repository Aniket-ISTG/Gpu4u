import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GPU4U — Decentralized Compute Router",
  description: "Intelligently analyze AI workloads and route to optimal, cost-efficient decentralized GPU compute nodes with real-time scoring.",
  icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full antialiased dark">
      <body className="min-h-full flex flex-col bg-[#090a0f] text-zinc-100 font-sans selection:bg-cyan-500/20 selection:text-cyan-200">
        {children}
      </body>
    </html>
  );
}
