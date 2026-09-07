import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Technocore Autonomous Agent // Room d-lesnak1",
  description:
    "Autonomous keepalive & cryptographic commerce agent for Technocore room d-lesnak1, powered by Flop Network A2A and TCLK micropayments.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="icon" href="/favicon.ico" sizes="any" />
      </head>
      <body className="min-h-screen bg-[#070a13] text-[#f1f5f9] antialiased selection:bg-sky-500/30 selection:text-sky-200">
        {children}
      </body>
    </html>
  );
}
