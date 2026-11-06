"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { action, ActionError } from "@/lib/action";
import { saveImapAccount } from "@/lib/google/account";
import { GoogleError } from "@/lib/google/errors";
import { encryptSecret, IMAP_PASSWORD } from "@/lib/secrets";
import { saveSettings } from "@/lib/settings-data";

import { testCalendar } from "./caldav";
import { closeImap, testImapLogin } from "./imap";

// Connecting a mailbox by IMAP, SMTP and CalDAV instead of Google (fork:
// nlappenbusch/dossier). Everything is tried first; only what works is saved.

const host = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9.-]+$/, "Enter just the server's name, such as mail.example.com.");

export const connectImap = action(
  z.strictObject({
    email: z.email("Enter the mailbox's address.").trim().toLowerCase(),
    password: z.string().min(1, "Enter the mailbox's password.").max(500),
    imapHost: host,
    imapPort: z.number().int().min(1).max(65535),
    smtpHost: host,
    smtpPort: z.number().int().min(1).max(65535),
    caldavUrl: z.union([z.literal(""), z.url("Enter the calendar's full address, starting with https://.")]),
  }),
  async ({ email, password, imapHost, imapPort, smtpHost, smtpPort, caldavUrl }, { toast }) => {
    const config = { user: email, password, imapHost, imapPort, smtpHost, smtpPort, caldavUrl: caldavUrl || null };
    try {
      await testImapLogin(config);
      await testCalendar(config);
    } catch (error) {
      if (error instanceof GoogleError) throw new ActionError(error.message);
      throw error;
    }
    await closeImap();
    await saveSettings({
      mailBackend: "imap",
      imapUser: email,
      imapPasswordEnc: encryptSecret(IMAP_PASSWORD, password),
      imapHost,
      imapPort,
      smtpHost,
      smtpPort,
      caldavUrl: caldavUrl || null,
    });
    await saveImapAccount(email);
    revalidatePath("/", "layout");
    toast(`Connected to ${email}.`);
    return null;
  },
);
