"use client";

import dynamic from "next/dynamic";

const FirePulseApp = dynamic(() => import("@/components/FirePulseApp"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "grid",
        placeItems: "center",
        background: "#05070a",
      }}
    >
      <div className="brand-mark" />
    </div>
  ),
});

export default function Page() {
  return <FirePulseApp />;
}
