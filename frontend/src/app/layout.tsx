import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BillsIQ — Property Accounting",
  description: "Utility bill and vendor invoice processing for multifamily accounting teams.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
