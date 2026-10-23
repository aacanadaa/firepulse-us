import type { Metadata } from "next";
import DocPage, { Contact } from "@/components/DocPage";

export const metadata: Metadata = { title: "Terms of use for FirePulse" };

export default function Terms() {
  return (
    <DocPage title="Terms of use" updated="October 23, 2026" draft>
      <h2>Not an official warning service</h2>
      <p>
        FirePulse brings together public fire, weather and air data and estimates of our own. It can be late,
        incomplete or wrong. Alerts can be delayed or never arrive: phones go offline, browsers drop push subscriptions,
        and data sources fail. The spread forecast is experimental. Never use FirePulse to decide whether to evacuate or
        to stay. Follow local officials and emergency alerts, and call 911 in an emergency.
      </p>

      <h2>Your account</h2>
      <p>
        Keep your password safe; there is no email reset. You&apos;re responsible for what happens under your account. We
        may suspend accounts that misuse the service.
      </p>

      <h2>Acceptable use</h2>
      <ul>
        <li>Only report smoke or fire you actually see. False reports put people at risk.</li>
        <li>Don&apos;t try to break, overload or get around the limits of the service.</li>
        <li>Automated access to the public API is fine within its rate limits, with credit to the data sources.</li>
      </ul>

      <h2>Data and credit</h2>
      <p>Map and fire data come from the public sources listed on the About page, under their own terms.</p>

      <h2>No warranty</h2>
      <p>
        FirePulse is provided as is, without warranties of any kind. To the extent the law allows, its operators aren&apos;t
        liable for any loss or harm from using it or relying on it.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms; the date above shows when. Questions: <Contact />.
      </p>
    </DocPage>
  );
}
