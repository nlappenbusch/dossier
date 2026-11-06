import "server-only";

import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";

import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import nodemailer from "nodemailer";

import { GoogleError } from "@/lib/google/errors";
import type { ReadMail } from "@/lib/google/gmail";
import { buildMessage, htmlToText, parseAddress, type OutgoingMail } from "@/lib/google/mime";

import { loadImapConfig, type ImapConfig } from "./config";

// Gmail's part done over IMAP and SMTP (fork: nlappenbusch/dossier), with the
// same functions gmail.ts offers, so the inbox check, matching and sending
// stay as they are.
//
// - A message's id is "<box>:<uidvalidity>:<uid>", box being inbox or sent.
// - The "history id" is where each box was: {"inbox":[uidvalidity,lastUid],"sent":[…]}.
// - A thread is the first Message-ID in References (else In-Reply-To, else
//   the message's own), which is how mail clients group a conversation; the
//   application's first email starts one with its own Message-ID.

type Box = "inbox" | "sent";
const BOXES: readonly Box[] = ["inbox", "sent"];

// ─── The connection ─────────────────────────────────────────────────────────
// One connection, reused while there's work and closed after a minute
// without: the inbox check reads many messages in a row.

type Shared = { client: ImapFlow | null; key: string; idle?: ReturnType<typeof setTimeout>; queue: Promise<unknown> };
const globalForImap = globalThis as unknown as { dossierImap?: Shared };
const shared = (globalForImap.dossierImap ??= { client: null, key: "", queue: Promise.resolve() });

const IDLE_MS = 60_000;

function connectionError(error: unknown): GoogleError {
  if (error instanceof GoogleError) return error;
  const text = error instanceof Error ? `${error.message} ${(error as { responseText?: string }).responseText ?? ""}` : String(error);
  if (/auth|login|credentials|password/i.test(text)) {
    return new GoogleError("revoked", "The mail server didn't accept the mailbox password. Connect your mailbox again in Settings → Google.", text);
  }
  return new GoogleError("unavailable", "Couldn't reach the mail server. Try again in a moment.", text, 503);
}

export function imapClient(config: ImapConfig): ImapFlow {
  return new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapPort === 993,
    auth: { user: config.user, pass: config.password },
    logger: false,
    // A server that can't be reached fails in seconds, not minutes.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
}

/** Runs `work` with the shared connection, one at a time. */
async function withImap<T>(work: (client: ImapFlow) => Promise<T>): Promise<T> {
  const run = async () => {
    const config = await loadImapConfig();
    const key = `${config.user}@${config.imapHost}:${config.imapPort}:${config.password.length}`;
    if (shared.idle) clearTimeout(shared.idle);
    if (!shared.client || !shared.client.usable || shared.key !== key) {
      await shared.client?.logout().catch(() => {});
      const client = imapClient(config);
      client.on("error", () => {});
      try {
        await client.connect();
      } catch (error) {
        throw connectionError(error);
      }
      shared.client = client;
      shared.key = key;
    }
    const client = shared.client;
    try {
      return await work(client);
    } catch (error) {
      if (error instanceof GoogleError) throw error;
      throw connectionError(error);
    } finally {
      shared.idle = setTimeout(() => {
        void shared.client?.logout().catch(() => {});
        shared.client = null;
      }, IDLE_MS);
      shared.idle.unref?.();
    }
  };
  const result = shared.queue.then(run, run);
  shared.queue = result.catch(() => {});
  return result;
}

/** The path of the inbox or the sent folder (by its special use, else a common name). */
async function boxPath(client: ImapFlow, box: Box): Promise<string> {
  if (box === "inbox") return "INBOX";
  const folders = await client.list();
  const sent = folders.find((folder) => folder.specialUse === "\\Sent") ?? folders.find((folder) => /^(sent|gesendet|sent items|sent messages)$/i.test(folder.name));
  if (!sent) throw new GoogleError("unavailable", "The mailbox has no folder for sent mail.");
  return sent.path;
}

// ─── Reading ────────────────────────────────────────────────────────────────

const angle = (id: string) => (id.startsWith("<") ? id : `<${id}>`);
const idList = (value: string | string[] | undefined): string[] =>
  (Array.isArray(value) ? value : (value ?? "").split(/\s+/)).map((entry) => entry.trim()).filter(Boolean).map(angle);

const addressText = (value: AddressObject | AddressObject[] | undefined) =>
  (Array.isArray(value) ? value : value ? [value] : []).map((entry) => entry.text).join(", ");

/** The thread a message belongs to: the first Message-ID of its conversation. */
export function threadOf(messageId: string, references: string[], inReplyTo: string[]): string {
  return references[0] ?? inReplyTo[0] ?? messageId;
}

async function readSource(source: Buffer, id: string, box: Box, internalDate?: Date): Promise<ReadMail> {
  const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true });
  const messageId = parsed.messageId ? angle(parsed.messageId) : `<${id.replace(/:/g, ".")}@dossier.invalid>`;
  const references = idList(parsed.references);
  const inReplyTo = idList(parsed.inReplyTo);
  const date = parsed.date ?? internalDate ?? new Date();
  return {
    id,
    threadId: threadOf(messageId, references, inReplyTo),
    labels: [box === "inbox" ? "INBOX" : "SENT"],
    from: addressText(parsed.from),
    to: addressText(parsed.to),
    subject: parsed.subject ?? "",
    messageId,
    references: references.join(" "),
    date: Number.isNaN(date.getTime()) ? new Date() : date,
    text: parsed.text?.trim() ? parsed.text : parsed.html ? htmlToText(parsed.html) : "",
  };
}

const makeId = (box: Box, uidValidity: bigint | number | string, uid: number) => `${box}:${String(uidValidity)}:${uid}`;

function splitId(id: string): { box: Box; uidValidity: string; uid: number } | null {
  const [box, uidValidity, uid, ...rest] = id.split(":");
  if (rest.length || (box !== "inbox" && box !== "sent") || !uidValidity || !/^\d+$/.test(uid ?? "")) return null;
  return { box, uidValidity, uid: Number(uid) };
}

/** One message, or null when it's gone (deleted, or the folder was rebuilt). */
export async function imapGetMessage(id: string): Promise<ReadMail | null> {
  const where = splitId(id);
  if (!where) return null;
  return withImap(async (client) => {
    const lock = await client.getMailboxLock(await boxPath(client, where.box), { readOnly: true });
    try {
      const mailbox = client.mailbox;
      if (!mailbox || String(mailbox.uidValidity) !== where.uidValidity) return null;
      const message = await client.fetchOne(String(where.uid), { source: true, internalDate: true }, { uid: true });
      if (!message || !message.source) return null;
      const internalDate = message.internalDate ? new Date(message.internalDate) : undefined;
      return readSource(message.source, id, where.box, internalDate);
    } finally {
      lock.release();
    }
  });
}

type History = Partial<Record<Box, [string, number]>>;

function parseHistory(value: string): History | null {
  try {
    const parsed = JSON.parse(value) as History;
    return typeof parsed === "object" && parsed ? parsed : null;
  } catch {
    return null;
  }
}

/** Where each folder is now, to check from next time. */
export async function imapCurrentHistoryId(): Promise<string> {
  return withImap(async (client) => {
    const history: History = {};
    for (const box of BOXES) {
      const status = await client.status(await boxPath(client, box), { uidNext: true, uidValidity: true });
      if (!status) throw new GoogleError("unavailable", "The mail server didn't say where the mailbox is.", undefined, 503);
      history[box] = [String(status.uidValidity), Math.max(0, Number(status.uidNext ?? 1) - 1)];
    }
    return JSON.stringify(history);
  });
}

/** Messages added since `historyId`; null when a folder was rebuilt (new UIDVALIDITY), so the caller starts over. */
export async function imapMessagesSince(historyId: string): Promise<{ ids: string[]; historyId: string } | null> {
  const before = parseHistory(historyId);
  if (!before) return null;
  return withImap(async (client) => {
    const ids: string[] = [];
    const after: History = {};
    for (const box of BOXES) {
      const lock = await client.getMailboxLock(await boxPath(client, box), { readOnly: true });
      try {
        const mailbox = client.mailbox;
        if (!mailbox) return null;
        const uidValidity = String(mailbox.uidValidity);
        const known = before[box];
        if (known && known[0] !== uidValidity) return null;
        const last = known?.[1] ?? Math.max(0, Number(mailbox.uidNext) - 1);
        const found = (await client.search({ uid: `${last + 1}:*` }, { uid: true })) || [];
        const fresh = found.filter((uid) => uid > last);
        for (const uid of fresh) ids.push(makeId(box, uidValidity, uid));
        after[box] = [uidValidity, Math.max(last, ...fresh)];
      } finally {
        lock.release();
      }
    }
    return { ids, historyId: JSON.stringify(after) };
  });
}

/**
 * Messages of the last days, newest first, up to `max`. Only Gmail's
 * "newer_than:<n>d" in the query counts; the rest is Gmail's own.
 */
export async function imapSearchMessages(query: string, { max = 100 }: { max?: number } = {}): Promise<string[]> {
  const days = Number(/newer_than:(\d+)d/.exec(query)?.[1] ?? 21);
  const since = new Date(Date.now() - days * 86_400_000);
  return withImap(async (client) => {
    const found: { id: string; uid: number; box: Box }[] = [];
    for (const box of BOXES) {
      const lock = await client.getMailboxLock(await boxPath(client, box), { readOnly: true });
      try {
        const uidValidity = String(client.mailbox ? client.mailbox.uidValidity : "");
        const uids = (await client.search({ since }, { uid: true })) || [];
        for (const uid of uids) found.push({ id: makeId(box, uidValidity, uid), uid, box });
      } finally {
        lock.release();
      }
    }
    // Newest first within each folder; the caller sorts by date anyway.
    return found.sort((a, b) => b.uid - a.uid).slice(0, max).map((entry) => entry.id);
  });
}

/**
 * The SMTP connection. Nodemailer asks DNS for the server's address itself,
 * which skips /etc/hosts (Docker's extra_hosts): behind a router without
 * hairpin NAT that's an address the container can't reach. So the address is
 * looked up the system's way, and the name kept for the certificate.
 */
async function smtpTransport(config: ImapConfig) {
  let address = config.smtpHost;
  try {
    address = (await lookup(config.smtpHost)).address;
  } catch {
    // Left to nodemailer, which says what's wrong.
  }
  return nodemailer.createTransport({
    host: address,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    requireTLS: config.smtpPort !== 465,
    name: config.user.split("@")[1] || undefined,
    tls: { servername: config.smtpHost },
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  });
}

// ─── Sending ────────────────────────────────────────────────────────────────

/**
 * Sends by SMTP and keeps a copy in the sent folder, as a mail client does.
 * With `threadId` it answers in that conversation: the thread's first
 * Message-ID goes into References, so the next reply still finds it.
 */
export async function imapSendMail(mail: OutgoingMail, { threadId }: { threadId?: string } = {}): Promise<{ id: string; threadId: string }> {
  const config = await loadImapConfig();
  const domain = config.user.split("@")[1] || config.imapHost;
  const messageId = mail.messageId ?? `<${Date.now().toString(36)}.${randomBytes(9).toString("hex")}@${domain}>`;
  const references = [...new Set([...idList(mail.references), ...(threadId ? [angle(threadId)] : [])])].filter((entry) => entry !== angle(mail.inReplyTo ?? ""));
  const raw = buildMessage({ ...mail, messageId, references: references.join(" ") || undefined });

  const recipients = mail.to
    .split(/[,;]/)
    .map((entry) => parseAddress(entry).address)
    .filter((address) => address.includes("@"));
  if (recipients.length === 0) throw new GoogleError("unavailable", "Add who it's to first.");

  const transport = await smtpTransport(config);
  try {
    await transport.sendMail({ envelope: { from: config.user, to: recipients }, raw });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/auth|535|credentials/i.test(text)) throw new GoogleError("revoked", "The mail server didn't accept the mailbox password for sending.", text);
    throw new GoogleError("unavailable", "The mail server didn't take the message. Nothing was sent; try again in a moment.", text);
  } finally {
    transport.close();
  }

  // The copy in Sent; its id is the one the inbox check will meet, so it isn't kept twice.
  let id = `sent:mid:${messageId}`;
  try {
    id = await withImap(async (client) => {
      const appended = await client.append(await boxPath(client, "sent"), raw, ["\\Seen"]);
      return appended && appended.uid && appended.uidValidity ? makeId("sent", appended.uidValidity, appended.uid) : id;
    });
  } catch {
    // Sent all the same; only the copy is missing.
  }
  return { id, threadId: threadId ?? messageId };
}

/** Checks that IMAP and SMTP take the password, before it's saved. Throws a message for the user. */
export async function testImapLogin(config: ImapConfig): Promise<void> {
  const client = imapClient(config);
  client.on("error", () => {});
  try {
    await client.connect();
    await boxPath(client, "sent");
  } catch (error) {
    throw connectionError(error);
  } finally {
    await client.logout().catch(() => {});
  }
  const transport = await smtpTransport(config);
  try {
    await transport.verify();
  } catch (error) {
    throw new GoogleError("rejected", "IMAP worked, but SMTP (sending) didn't. Check the SMTP server and port.", error instanceof Error ? error.message : String(error));
  } finally {
    transport.close();
  }
}

/** Closes the shared connection, e.g. after disconnecting. */
export async function closeImap(): Promise<void> {
  if (shared.idle) clearTimeout(shared.idle);
  await shared.client?.logout().catch(() => {});
  shared.client = null;
}
