import type { Metadata, Viewport } from "next";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "FirePulse US — National fire picture",
  description:
    "Sub-5-minute wildfire early detection: satellite thermal anomalies, CAD dispatch, camera vectors and crowdsourced reports fused into live Estimated Active Fire Zones alongside official NIFC perimeters.",
  applicationName: "FirePulse US",
  keywords: ["wildfire", "early detection", "GOES", "FIRMS", "NIFC", "PostGIS", "MapLibre"],
};

export const viewport: Viewport = {
  themeColor: "#f7f7f5",
  colorScheme: "light",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
