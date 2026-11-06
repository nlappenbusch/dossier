import "server-only";

import { decryptSecret, IMAP_PASSWORD } from "@/lib/secrets";
import { loadSettings } from "@/lib/settings-data";
import { GoogleError } from "@/lib/google/errors";

// Mailcow / IMAP instead of Google (fork: nlappenbusch/dossier). One mailbox
// password reaches IMAP (reading), SMTP (sending) and CalDAV (the calendar).
// Settings → Google keeps working as it is: the Gmail and Calendar modules ask
// here first and hand the work to ./imap and ./caldav when this is chosen.

export type ImapConfig = {
  user: string;
  password: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** The calendar collection, or null without a calendar. */
  caldavUrl: string | null;
};

/** Whether mail and calendar go through IMAP, SMTP and CalDAV rather than Google. */
export async function usesImap(): Promise<boolean> {
  return (await loadSettings()).mailBackend === "imap";
}

/** The saved connection; throws a message for the user while it isn't complete. */
export async function loadImapConfig(): Promise<ImapConfig> {
  const settings = await loadSettings();
  if (settings.mailBackend !== "imap" || !settings.imapUser || !settings.imapPasswordEnc || !settings.imapHost) {
    throw new GoogleError("not-connected", "Connect your mailbox in Settings → Google first.");
  }
  let password: string;
  try {
    password = decryptSecret(IMAP_PASSWORD, settings.imapPasswordEnc);
  } catch {
    throw new GoogleError("revoked", "The saved mailbox password can't be read, probably since DOSSIER_SECRET changed. Connect your mailbox again.");
  }
  return {
    user: settings.imapUser,
    password,
    imapHost: settings.imapHost,
    imapPort: settings.imapPort,
    smtpHost: settings.smtpHost || settings.imapHost,
    smtpPort: settings.smtpPort,
    caldavUrl: settings.caldavUrl || null,
  };
}

/** SOGo's calendar address for a Mailcow mailbox: https://<host>/SOGo/dav/<user>/Calendar/personal/ */
export const sogoCalendarUrl = (host: string, user: string) => `https://${host}/SOGo/dav/${encodeURIComponent(user)}/Calendar/personal/`;
