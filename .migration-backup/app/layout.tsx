import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HCI Voice Assistant",
  description: "Full-screen bedside voice control with live HCI room actions and guided status feedback"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
