"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { connectImap } from "@/lib/mailcow/actions";

// Mailcow / IMAP instead of Google (fork: nlappenbusch/dossier): one form for
// the mailbox, the servers and the calendar. Nothing is saved until IMAP,
// SMTP and the calendar all take the password.

/** What the form starts with; never the password. */
export type ImapView = {
  email: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  caldavUrl: string;
  /** The server suggested for a new mailbox (DOSSIER_MAIL_HOST), or "". */
  defaultHost: string;
};

const sogoUrl = (host: string, email: string) => (host && email.includes("@") ? `https://${host}/SOGo/dav/${email}/Calendar/personal/` : "");

export function ImapCard({ initial, onConnected }: { initial: ImapView; onConnected?: () => void }) {
  const router = useRouter();
  const [email, setEmail] = useState(initial.email);
  const [password, setPassword] = useState("");
  const [host, setHost] = useState(initial.imapHost || initial.defaultHost);
  const [imapPort, setImapPort] = useState(String(initial.imapPort || 993));
  const [smtpHost, setSmtpHost] = useState(initial.smtpHost);
  const [smtpPort, setSmtpPort] = useState(String(initial.smtpPort || 465));
  const [caldavUrl, setCaldavUrl] = useState(initial.caldavUrl);
  const [calendarTouched, setCalendarTouched] = useState(Boolean(initial.caldavUrl));
  const [advanced, setAdvanced] = useState(false);
  const [pending, startTransition] = useTransition();

  // Mailcow's calendar (SOGo) follows from the server and the address, until it's typed over.
  const calendar = calendarTouched ? caldavUrl : sogoUrl(host.trim(), email.trim().toLowerCase());

  const connect = () =>
    startTransition(async () => {
      const result = toastResult(
        await connectImap({
          email,
          password,
          imapHost: host,
          imapPort: Number(imapPort),
          smtpHost: smtpHost.trim() || host,
          smtpPort: Number(smtpPort),
          caldavUrl: calendar.trim(),
        }),
      );
      if (result.ok) {
        setPassword("");
        onConnected?.();
        router.refresh();
      }
    });

  return (
    <Card className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h3 className="text-control font-medium">Mailcow or another mail server</h3>
        <p className="text-pretty text-sm text-muted">
          Instead of Google: Dossier sends by SMTP, reads replies by IMAP and keeps interviews in your calendar by CalDAV, all with your mailbox&apos;s
          password, which is stored encrypted on this server. For Mailcow the calendar is filled in for you.
        </p>
      </div>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          connect();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Email address" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required />
          <Input label="Password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          <Input label="Mail server" hint="Mailcow: the server's name, e.g. mail.example.com" value={host} onChange={(event) => setHost(event.target.value)} required />
          <Input
            label="Calendar (CalDAV)"
            hint="Leave empty for mail only"
            value={calendar}
            onChange={(event) => {
              setCalendarTouched(true);
              setCaldavUrl(event.target.value);
            }}
          />
        </div>
        {advanced ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <Input label="IMAP port" inputMode="numeric" value={imapPort} onChange={(event) => setImapPort(event.target.value)} />
            <Input label="SMTP server" hint="Empty: the mail server" value={smtpHost} onChange={(event) => setSmtpHost(event.target.value)} />
            <Input label="SMTP port" hint="465 (TLS) or 587 (STARTTLS)" inputMode="numeric" value={smtpPort} onChange={(event) => setSmtpPort(event.target.value)} />
          </div>
        ) : (
          <button type="button" className="self-start text-meta text-muted underline underline-offset-2 hover:text-ink" onClick={() => setAdvanced(true)}>
            Ports and SMTP server
          </button>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Checking…" : "Connect mailbox"}
          </Button>
          <span className="text-meta text-muted">IMAP, SMTP and the calendar are tried first; nothing is saved unless they work.</span>
        </div>
      </form>
    </Card>
  );
}
