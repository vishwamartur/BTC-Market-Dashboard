import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BTC Liquidation Dashboard | Real-Time Bitcoin Futures Liquidations",
  description:
    "Track real-time Bitcoin (BTC) futures liquidation events, long/short positions, open interest, and market sentiment. Live data from Binance Futures.",
  keywords: [
    "BTC liquidation",
    "Bitcoin futures",
    "crypto liquidation",
    "long short ratio",
    "open interest",
    "Binance futures",
    "real-time crypto",
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
