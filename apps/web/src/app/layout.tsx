import type { Metadata, Viewport } from "next";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";

export const metadata: Metadata = {
  title: "FirePulse US: National fire picture",
  description:
    "Sub-5-minute wildfire early detection: satellite thermal anomalies, CAD dispatch, camera vectors and crowdsourced reports fused into live Estimated Active Fire Zones alongside official NIFC perimeters.",
  applicationName: "FirePulse US",
  keywords: ["wildfire", "early detection", "GOES", "FIRMS", "NIFC", "PostGIS", "MapLibre"],
  manifest: "/manifest.webmanifest",
  icons: { apple: "/icons/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "FirePulse", statusBarStyle: "default" },
  openGraph: {
    type: "website",
    siteName: "FirePulse US",
    title: "FirePulse US — National fire picture",
    description:
      "Live wildfire early detection: thermal anomalies fused into Early Active Fire Zones next to official NIFC perimeters.",
    url: "https://firepulse-us.vercel.app",
    images: [{ url: "/icons/icon-512.png", width: 512, height: 512, alt: "FirePulse US" }],
  },
  twitter: {
    card: "summary",
    title: "FirePulse US — National fire picture",
    description: "Live wildfire early detection, fused from satellite, dispatch and weather signals.",
    images: ["/icons/icon-512.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#f7f7f5",
  // Both appearances ship; native controls and scrollbars should follow.
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        {/* Applies the stored appearance before first paint, so dark mode never flashes white. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
