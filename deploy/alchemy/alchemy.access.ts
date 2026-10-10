// The contract shared by the two email-gated Cloudflare Access boundaries —
// the persistent preview wildcard (alchemy.preview-access.run.ts) and the
// per-stage self-host gate (alchemy.run.ts). Worker naming, the
// WORKERS_SUBDOMAIN shape, the allowed-emails parsing, and the
// policy/application shape define who gets through which hostnames; keep them
// in one place so the two gates cannot drift. The one copy that can't import
// this module is the shell in .github/workflows/pr-preview.yml — its
// `open-seo-<stage>` naming stays comment-synced (and is backstopped by the
// workflow's Access verify step).

import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const WORKER_PREFIX = "open-seo";

// The one stage that adopts openseo.so's live hosted resources (unsuffixed
// names, app.openseo.so domain, Postgres). Deliberately not "prod" so a
// self-hoster's stage name can't collide with the adoption path.
export const HOSTED_PROD_STAGE = "hosted-prod";

export const workerName = (stage: string) =>
  stage === HOSTED_PROD_STAGE ? WORKER_PREFIX : `${WORKER_PREFIX}-${stage}`;

// Matches every preview worker hostname; production's unsuffixed worker does
// not match (Access allows one wildcard per dot-label).
export const previewWildcard = (subdomain: string) =>
  `${WORKER_PREFIX}-*.${subdomain}`;

export const readWorkersSubdomain = ({ required }: { required: boolean }) =>
  Effect.gen(function* () {
    const subdomain = (yield* Config.string("WORKERS_SUBDOMAIN").pipe(
      Config.withDefault(""),
    )).trim();
    if (subdomain.endsWith(".workers.dev") || (!subdomain && !required)) {
      return subdomain;
    }
    return yield* Effect.die(
      new Error(
        `Set WORKERS_SUBDOMAIN to the account's full workers.dev subdomain (shown under Workers & Pages)${required ? "." : ", or leave it unset."}`,
      ),
    );
  });

/** Reads ACCESS_ALLOWED_EMAILS; dies with `remedy` when none are set. */
export const requireAllowedEmails = (remedy: string) =>
  Effect.gen(function* () {
    const emails = (yield* Config.string("ACCESS_ALLOWED_EMAILS").pipe(
      Config.withDefault(""),
    ))
      .split(",")
      .map((email) => email.trim())
      .filter(Boolean);
    if (emails.length === 0) {
      return yield* Effect.die(new Error(remedy));
    }
    return emails;
  });

/** The gate itself: an email allow-policy on a self-hosted Access application. */
export const emailAccessGate = (options: {
  policyId: string;
  applicationId: string;
  policyName: string;
  applicationName: string;
  domain: string;
  /**
   * Further hostnames the same gate must cover — a self-host CUSTOM_DOMAIN on
   * top of the workers.dev hostname, which stays live either way. Access
   * enforces per hostname: one missing here reaches the Worker with no
   * `cf-access-jwt-assertion` header, which the app rejects as unconfigured
   * (src/middleware/ensure-user/cloudflareAccess.ts).
   */
  extraDomains?: string[];
  emails: string[];
  /**
   * Access service tokens (their UUIDs, not client ids) admitted without a
   * login — how an MCP agent gets through with `CF-Access-Client-Id` and
   * `CF-Access-Client-Secret` headers instead of a browser session.
   */
  serviceTokenIds?: string[];
}) =>
  Effect.gen(function* () {
    const allow = yield* Cloudflare.Access.Policy(options.policyId, {
      name: options.policyName,
      decision: "allow",
      include: options.emails.map((email) => ({ email: { email } })),
    });
    const policies = [allow.policyId];
    if (options.serviceTokenIds?.length) {
      const serviceAuth = yield* Cloudflare.Access.Policy(
        `${options.policyId}ServiceTokens`,
        {
          name: `${options.policyName} service tokens`,
          decision: "non_identity",
          include: options.serviceTokenIds.map((tokenId) => ({
            serviceToken: { tokenId },
          })),
        },
      );
      policies.push(serviceAuth.policyId);
    }
    return yield* Cloudflare.Access.Application(options.applicationId, {
      type: "self_hosted",
      name: options.applicationName,
      domain: options.domain,
      // `domain` is Cloudflare's single-hostname shorthand; the multi-hostname
      // form is `destinations`, which must then list the primary hostname too.
      ...(options.extraDomains?.length
        ? {
            destinations: [options.domain, ...options.extraDomains].map(
              (uri) => ({ type: "public" as const, uri }),
            ),
          }
        : {}),
      policies,
    });
  });
