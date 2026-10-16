import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://applypilot-hub.amused-bream-5718.chatgpt.site"),
  title: "ApplyPilot",
  description:
    "A private dashboard for matching resumes, preparing applications, and tracking employer accounts safely.",
  openGraph: {
    title: "ApplyPilot",
    description: "A safer, faster way to prepare and track job applications.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "ApplyPilot job search command center" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "ApplyPilot",
    description: "A safer, faster way to prepare and track job applications.",
    images: ["/og.png"],
  },
  alternates: {
    canonical: "/",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="bg-[#07111f]">
      <body className="antialiased">{children}</body>
    </html>
  );
}
