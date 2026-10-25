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
