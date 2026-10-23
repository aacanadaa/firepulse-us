import type { Metadata } from "next";
import DocPage, { Contact } from "@/components/DocPage";

export const metadata: Metadata = { title: "Privacy at FirePulse" };

export default function Privacy() {
  return (
    <DocPage title="Privacy" updated="October 23, 2026" draft>
      <p>
        FirePulse needs to know where your places are to tell you about fires near them. This page says what we keep,
        why, and who else sees it. We don&apos;t sell data, show ads or use analytics trackers.
      </p>

      <h2>Without an account</h2>
      <p>
        Places you add are kept in your browser. To show what&apos;s near them, your browser sends their coordinates to
        our server, which answers and doesn&apos;t store them.
      </p>

      <h2>With an account</h2>
      <ul>
        <li>Your username and a salted hash of your password (never the password itself).</li>
        <li>If you sign in with Google: your Google account ID, email address and name.</li>
        <li>The places you watch: their names, locations and alert radius.</li>
        <li>Your alert settings, including quiet hours and time zone.</li>
        <li>
          For each device with alerts on: the push address your browser&apos;s push service gives us (Google, Apple, Mozilla
          or Microsoft, depending on the browser) and the browser type.
        </li>
        <li>The alerts we sent you, kept for 90 days so you can review them.</li>
        <li>A session cookie that keeps you signed in for up to 30 days.</li>
      </ul>

      <h2>Smoke reports</h2>
      <p>
        A report&apos;s location and description appear on the public map as an unverified report, without your name. We
        record which account sent it so we can stop misuse.
      </p>

      <h2>Who else sees data</h2>
      <ul>
        <li>Address searches go to the US Census Bureau geocoder and to Photon (komoot).</li>
        <li>Alerts travel through your browser&apos;s push service, encrypted so only your device can read them.</li>
        <li>If you choose the Topographic or Satellite map, map images load from Esri or EOX, which see your IP address.</li>
        <li>Our hosting providers process this data for us. Server logs record IP addresses for security and rate limiting.</li>
      </ul>

      <h2>Your choices</h2>
      <p>
        Turn alerts off on any device in alert settings. Deleting your account (alert settings, then Account) removes
        your account, places, devices and alert history right away. Questions: <Contact />.
      </p>
    </DocPage>
  );
}
