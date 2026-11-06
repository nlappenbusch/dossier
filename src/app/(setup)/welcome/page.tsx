import type { Metadata } from "next";
import Link from "next/link";

import { buttonClassName } from "@/components/ui/button";
import { verifySession } from "@/lib/auth/session";
import { isAiConfigured, isAiUsable, loadAiConfig, loadAiSettingsView } from "@/lib/ai/config";
import { jobSearchView, loadJobSearchConfig } from "@/lib/job-search/config";
import { SOURCE_INFO } from "@/lib/job-search/sources";
import { loadProfileName } from "@/lib/profile-data";
import { SCORER_INFO } from "@/lib/scoring/scorers";
import { jobRetentionLabel } from "@/lib/settings";
import { loadScoringConfig, scoringView } from "@/lib/scoring/config";
import { providerOption } from "@/lib/ai/provider-options";
import { env } from "@/lib/env";
import { isDesktopApp } from "@/lib/desktop";
import { redirectUri } from "@/lib/google/oauth";
import { loadSettings } from "@/lib/settings-data";
import { googleClientView, googleView, imapView, requestOrigin } from "@/lib/settings-views";
import { aiChoice, choiceOf } from "@/lib/setup/ai-choices";
import { googleAddressProblem } from "@/lib/setup/google";
import { setupHref, setupStepFromParam } from "@/lib/setup-guide";

import { ProfileImport } from "../../(app)/profile/import/profile-import";
import { AiStep } from "./ai-step";
import { GoogleStep } from "./google-step";
import { JobsStep } from "./jobs-step";
import { ScoringStep } from "./scoring-step";
import { SetupFrame } from "./setup-frame";

export const metadata: Metadata = { title: "Set up Dossier" };

/** The setup guide (E21); the step is in `?step=`, else where it was left. */
export default async function WelcomePage({ searchParams }: PageProps<"/welcome">) {
  // The layout checks too; this is the check next to the data (E11-5).
  await verifySession();
  const [{ step: param, google, job }, settings] = await Promise.all([searchParams, loadSettings()]);
  const step = setupStepFromParam(param, settings.setupGuide);

  if (step === "start") {
    return (
      <SetupFrame
        step="start"
        title="Welcome to Dossier"
        complete
        lead={
          <>
            <p>
              A few steps get it ready: an AI to write your resumes and letters, where to look for jobs, how to judge them, your Gmail and
              calendar, and your profile.
            </p>
            <p className="mt-3">
              Each step says where to go, what to click and what to copy back here. You can skip any of them and come back later from Settings.
            </p>
          </>
        }
      >
        <div>
          <Link href={setupHref("ai")} className={buttonClassName("primary", "md", "hover:text-on-primary")}>
            Let&apos;s start →
          </Link>
        </div>
      </SetupFrame>
    );
  }

  if (step === "done") {
    const [usable, view, jobs, scoring, connection, name] = await Promise.all([
      isAiUsable(),
      loadAiSettingsView(),
      loadJobSearchConfig(),
      loadScoringConfig(),
      googleView(),
      loadProfileName(),
    ]);
    const choice = choiceOf(view.provider, view.baseUrl);
    const rows = [
      { label: "AI", value: usable ? (choice ? aiChoice(choice).name : providerOption(view.provider).name) : null, href: "/settings?section=ai" },
      { label: "Job search", value: jobs.source ? SOURCE_INFO[jobs.source].name : null, href: "/settings?section=jobs" },
      { label: "Scoring", value: SCORER_INFO[scoring.scorer].name, href: "/settings?section=scoring" },
      { label: "Gmail and Calendar", value: connection.status === "connected" ? connection.email : null, href: "/settings?section=google" },
      { label: "Profile", value: name.trim() || null, href: "/profile" },
    ];
    return (
      <SetupFrame step="done" title="You're all set" complete lead="Anything you skipped waits in Settings, and so does this guide, under About.">
        <dl className="flex max-w-[560px] flex-col rounded-card border border-line-card bg-card px-6 py-2">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-4 border-t border-line py-3 text-sm first:border-t-0">
              <dt className="font-medium">{row.label}</dt>
              <dd className="flex items-center gap-3 text-right">
                <span className={row.value ? "" : "text-muted"}>{row.value ?? "Not set up"}</span>
                <Link href={row.href} className="text-meta text-muted underline underline-offset-2 hover:text-ink">
                  Change <span className="sr-only">{row.label}</span>
                </Link>
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap items-center gap-3">
          {name.trim() ? (
            <Link href="/new?fresh=1" className={buttonClassName("primary", "md", "hover:text-on-primary")}>
              Start your first application
            </Link>
          ) : (
            <Link href="/profile" className={buttonClassName("primary", "md", "hover:text-on-primary")}>
              Fill in your profile
            </Link>
          )}
          <Link href="/" className={buttonClassName("secondary")}>
            Go to the dashboard
          </Link>
        </div>
      </SetupFrame>
    );
  }

  if (step === "ai") {
    const [usable, view] = await Promise.all([isAiUsable(), loadAiSettingsView()]);
    const choice = choiceOf(view.provider, view.baseUrl);
    return (
      <SetupFrame
        step="ai"
        title="Choose an AI"
        complete={usable}
        lead="It reads job postings and writes your resumes and cover letters. Pick what matters most to you, and the guide shows you where to go, what to click and what to copy back here."
      >
        <AiStep
          current={{
            usable,
            name: choice ? aiChoice(choice).name : providerOption(view.provider).name,
            model: view.model,
            choice,
            fromEnv: !settings.provider && Boolean(env.DOSSIER_AI_PROVIDER),
          }}
        />
      </SetupFrame>
    );
  }

  if (step === "jobs") {
    const view = jobSearchView(await loadJobSearchConfig());
    return (
      <SetupFrame
        step="jobs"
        title="Where to look for jobs"
        complete={settings.jobSource !== null || view.source !== "OFF"}
        lead="Find jobs and the job agent search one source for postings that fit you. You can also paste any posting you find yourself."
      >
        <JobsStep initial={view} />
      </SetupFrame>
    );
  }

  if (step === "scoring") {
    const view = scoringView(await loadScoringConfig());
    return (
      <SetupFrame
        step="scoring"
        title="How to judge a posting"
        complete={view.scorer === "AI" || view.keyState === "set" || view.keyState === "env"}
        lead="Score in Find jobs and the job agent say how well a posting fits your profile, so you can see the good ones first. Your resumes and letters are always written by your AI."
      >
        <ScoringStep initial={view} />
      </SetupFrame>
    );
  }

  if (step === "google" && isDesktopApp()) {
    // Google doesn't come back to the desktop app's own server yet (#327).
    return (
      <SetupFrame
        step="google"
        title="Gmail and Calendar"
        complete={false}
        lead="Connecting a Google account doesn't work yet when Dossier runs on this computer. It does with Dossier on a server, which this app opens too, with On my server. Skip this step for now: everything else works without it."
      >
        {null}
      </SetupFrame>
    );
  }

  if (step === "google") {
    const [connection, client, origin, imap] = await Promise.all([googleView(), googleClientView(), requestOrigin(), imapView()]);
    const uri = redirectUri(origin);
    return (
      <SetupFrame
        step="google"
        title="Gmail and Calendar"
        complete={connection.status === "connected"}
        lead="Optional. With your mailbox connected, Dossier sends applications from your address, links employers' replies to them, drafts your answers and offers times you're free. Use Google (a few pages in Google Cloud, done once) or your own mail server such as Mailcow (address and password)."
      >
        <GoogleStep
          connection={connection}
          client={client}
          redirectUri={uri}
          addressProblem={googleAddressProblem(uri)}
          outcome={typeof google === "string" ? google : null}
          imap={imap}
        />
      </SetupFrame>
    );
  }

  const [aiReady, ai, name] = await Promise.all([isAiConfigured(), loadAiConfig(), loadProfileName()]);
  return (
    <SetupFrame
      step="profile"
      title="Your profile"
      complete={Boolean(name.trim())}
      lead={
        name.trim()
          ? "Your profile already has your name. Importing a resume adds to it or replaces it: you choose once you've seen what was found."
          : "Everything Dossier writes is built from your profile: your roles, skills and education. Start it from a resume you already have, or skip this step and fill it in yourself."
      }
    >
      <ProfileImport aiReady={aiReady} provider={ai.provider} initialJobId={typeof job === "string" ? job : null} keptFor={jobRetentionLabel(settings.jobRetentionHours)} inGuide />
    </SetupFrame>
  );
}
