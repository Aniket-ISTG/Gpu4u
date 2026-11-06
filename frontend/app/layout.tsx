import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GPU4U — Decentralized Compute Router",
  description:
    "Intelligently analyze AI workloads and route to optimal, cost-efficient decentralized GPU compute nodes with real-time scoring.",
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
      <body className="min-h-full flex flex-col font-sans text-[#FAF4EB] selection:bg-[#E8D2B5] selection:text-[#1E3A5F]">
        {children}
      </body>
    </html>
  );
}
