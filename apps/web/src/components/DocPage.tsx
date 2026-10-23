import Link from "next/link";
import type { ReactNode } from "react";

const CONTACT = process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? "";
const REVIEWED = process.env.NEXT_PUBLIC_LEGAL_REVIEWED === "true";

export function Contact() {
  return CONTACT ? <a href={`mailto:${CONTACT}`}>{CONTACT}</a> : <span>the address listed by whoever runs this site</span>;
}

/** A plain reading page: About, Privacy and Terms. */
export default function DocPage({ title, updated, draft, children }: { title: string; updated?: string; draft?: boolean; children: ReactNode }) {
  return (
    <div className="doc-page">
      <header className="doc-head">
        <Link href="/" className="doc-brand">
          <span className="brand-mark" aria-hidden />
          FirePulse
        </Link>
        <nav>
          <Link href="/about">About &amp; data</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </nav>
      </header>
      <main className="doc">
        {draft && !REVIEWED ? (
          <p className="doc-draft">Draft: this text hasn&apos;t been reviewed yet and may change before launch.</p>
        ) : null}
        <h1>{title}</h1>
        {updated ? <p className="doc-updated">Last updated {updated}</p> : null}
        {children}
      </main>
    </div>
  );
}
