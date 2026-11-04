import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AppProvider } from "@/lib/app-context";
import { AppHeader } from "@/components/shell/AppHeader";
import { Overlays } from "@/components/shell/Overlays";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "NearOdds — prediction markets on NEAR",
  description: "Browse binary prediction markets, compare odds and trade YES/NO outcomes on NEAR.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#090D11" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="font-sans min-h-dvh bg-page text-fg antialiased">
        <AppProvider>
          <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-lg focus:bg-brand focus:px-3 focus:py-2">Skip to content</a>
          <AppHeader />
          <main id="main" className="mx-auto w-full max-w-[1320px] px-4 pb-24 pt-5 md:px-6 lg:pb-8">{children}</main>
          <Overlays />
        </AppProvider>
      </body>
    </html>
  );
}
