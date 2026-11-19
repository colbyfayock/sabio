# Release runbook

The checked-in default remains a **local preview**. The owner-managed Worker now runs
owner-initiated pairing (deployed 2026-10-23); production revocation of the test session
and frame validation are pending. This runbook records release gates, not permission to
make further deployments or create resources. The intended release is a single-owner
Horizon dashboard with ZIP-driven Fahrenheit weather/time and owner-issued display
pairings. Google Photos Picker imports are deployed as explicit still-photo snapshots;
the owner-run OAuth/import/display flow and frame test remain unverified. There is no
calendar/task integration or automatic whole-album sync.

## Initial deployment status

The first explicitly approved Free-only batch created one Sabio Worker/D1 database,
one reusable exact-owner allow policy and one Access application covering only the
admin UI/API paths on the account's `workers.dev` address. The custom hostname
`sabio.fayock.com` is also routed to the Worker; its route is declared in the ignored
production config so subsequent Wrangler deploys preserve it. The owner-local
configuration, resource/version IDs and setup credentials remain ignored under
`private/`; the token is never a Worker binding or frontend variable. The public local
config is unchanged. No paid upgrade or unrelated Access/network rule was applied.

Remote checks of the earlier flow passed: HTTPS shell/security headers, managed
bootstrap, unapproved weather/display denial, forged cookie rejection, owner-path login
redirects, CSRF denial, pending enrollment and private-path 404s. The new deployment
was smoke-tested for removed public endpoints, Access redirects, cross-origin claim
denial and invalid-code denial. One owner-run pairing loaded the dashboard; replay was
denied and the owner confirmed the notification email arrived. Revocation of that test
session remains pending. After the pairing deploy, the custom hostname temporarily
returned a 307 to the portfolio because its Worker route was missing from the production
config. The existing proxied hostname was restored as a Worker Route without changing
DNS; custom `/`, `/health`, `/api/bootstrap`, display denial and Access redirect checks
now pass. Hardware remains a gate.
The first release has no earlier good deployed version to roll back to; do not assume
an untested code rollback or database recovery procedure has been proven.

Additive `0002_display_details.sql` and `0003_display_names.sql` with matching Worker/
static assets are deployed. Existing displays keep their session and fill in metadata
at the next bootstrap and successful weather lookup. Owners can assign a display
nickname. No raw UA, ZIP, coordinates, GPS or IP-derived location is stored for these
features. See the admin metadata disclosure in [security](../SECURITY.md).

Additive `0004_access_cleanup_indexes.sql` is applied and the Worker now runs the
bounded cleanup batch on a `*/15` cron schedule. Two managed origins are allowlisted
(the custom hostname and the `workers.dev` address); both serve the security headers
and redirect `/admin` to Access when signed out. Treat unlisted origins as denied.

Private Google Photos imports are deployed to the existing Worker. Production bucket
`sabio-private-photos` is bound only to the Worker, `r2.dev` is disabled, and additive
migrations `0005_private_photos.sql` and `0006_google_photo_connection.sql` are applied.
The existing production client ID and secrets are bound to the active version. The app
requests only `photospicker.mediaitems.readonly`, encrypts the refresh token in D1, and
offers **Disconnect Google Photos**; already imported photos remain in R2 after
disconnect. The owner searches for an album and explicitly selects up to 12 photos per
snapshot import; it does not sync albums continuously. While Google's OAuth app is in
Testing, refresh tokens can expire after seven days, after which Sabio offers reconnect.

Production smoke checks pass for the public shell/health, Access redirects on `/admin`
and `/api/admin/photos`, and unauthenticated photo-list denial. No real owner OAuth
callback, Picker selection/import, paired-display image load, deletion/revocation browser
test or frame test has yet been completed. A strict regular deploy found route/config
drift, so this release used Wrangler Versions and left routes/triggers unchanged. Reconcile
that drift before a future standard deploy. The active version also includes the existing
uncommitted Horizon UI/weather refinements. No commit, paid-plan change or DNS change was
made.

For future OAuth clients, use the Google Photos **Picker API** (not the separate Google
Picker UI API), a Web application client, and exact HTTPS callback
`<APP_ORIGIN>/api/admin/photos/callback`. Keep Client IDs as Worker vars and secrets out of
source control. Maintain private-only bucket access and verify account usage controls.

Owner-initiated pairing reuses the existing enrollment table and requires no new
migration. Existing display sessions remain valid. Legacy display-initiated pending
rows are deliberately not claimable by the new route and expire through normal cleanup;
those browsers must be paired again.

Rolling display sessions are deployed as of 2026-10-22; the Worker version is recorded
privately. Active displays renew the seven-day idle window at most once per day and
receive a replacement cookie. Optional owner email notifications are implemented and
enabled in the owner deployment: the private production config has a `send_email`
binding and `NOTIFY_FROM_EMAIL`. The public preview config has neither and stays silent.

## Local verification

From the local shared workspace parent:

```sh
pnpm --dir sabio check
pnpm --dir sabio build:worker
git -C sabio diff --check
git -C sabio status --short
```

When the repository is checked out alone, use the equivalent package commands at
its root. `build:worker` is a packaging dry run, not an upload. Keep preview servers
on loopback. Inspect the output allowlist: display/admin HTML, CSS, app/admin JS and favicon;
no mockups, private settings, captures, secrets, state databases or source maps.

Use synthetic data in browser tests. Verify both themes at 1280×800 and a small
viewport; Sabio options open/close; ZIP Save/Cancel/Reset; keyboard focus trapping/
restoration in both dialogs; fullscreen entry/exit from Display options; transparent
left/right photo navigation, ten-minute default hold, reload persistence and broken
source recovery; and weather refresh/timeout/offline/stale behavior. Test timezone/DST
and theme boundaries. There is no photo-source editor in the current UI.
Inspect captures then delete the exact files immediately. Desktop browser tests do
not establish Firefox Android 68 compatibility.

## Access-control gate — implemented locally, deployment verification pending

The code and tests now cover these controls; the real account/policy configuration
and deployed verification remain required. See [access control](access-control.md).

Before making the API publicly reachable:

- Authenticate the owner on a trusted modern browser. A plain forwarded email header
  is not identity verification. If using Cloudflare Access, validate its signed JWT
  issuer, audience, signature and lifetime, and restrict the actual owner identity.
- Store display registrations, session hashes, revocation, bounded pairing state
  and per-display settings in the agreed storage. Decide schema, deletion/retention
  and atomic one-time pairing consumption before running migrations.
- Generate a pairing code only after explicit owner action, only while pairing the
  intended display, and treat it as a bearer secret. Expire codes quickly, keep only
  the newest owner-issued code valid, bound claim attempts and prevent
  replay/concurrent double consumption. Do not restore a public display-initiated
  enrollment/approval path.
- Use scoped Secure/HttpOnly cookies, a documented idle-timeout renewal, and CSRF
  protection. A frame session must not authorize administration or another display.
- Check authorization on every private route, alternate host and encoded-path variant.
  Ensure static fallback and shared caches cannot expose configuration or private data.
- Protect weather usage with agreed authorization and rate/abuse limits, including
  pairing traffic. Origin checks alone are not authentication or rate limiting.
- Prove denial, forgery resistance, expiry, concurrent pairing, revocation and
  cross-display isolation with automated tests and local runtime checks. Storage or
  identity-provider failures must fail closed, not open a preview bypass.
- For private photos, verify owner-only OAuth state/callback handling, encrypted
  refresh-token storage, refresh/reconnect behavior, Google token revocation on
  disconnect, active Picker cleanup and retention of imported R2 objects. Verify bounded
  still-image import, metadata sanitization, authenticated private R2 delivery,
  cross-origin denial and display-revocation denial. Confirm `r2.dev` and public bucket
  domains are disabled; do not return signed URLs or Google base URLs to clients.

Browser pairing is not hardware attestation. The obsolete/root-accessible frame
can expose everything displayed to it; use only non-sensitive content in this MVP.

### Optional owner email notifications

A notification is sent once, when a display actually claims its session. Its subject
is `[Login] Sabio authentication request`, and it contains the UTC time, display ID, a
coarse browser/OS label, an approximate network location derived from Cloudflare's
request metadata (city/region/country only, not persisted by Sabio) and a dashboard
link. It never contains IP addresses, ZIP codes, precise coordinates, raw User-Agent
strings, cookies, pairing codes or display content. Delivery failures are logged as a
static event and never block or roll back session issuance.

To enable it with a separately approved configuration:

- Verify the owner address as an Email Routing destination in the account.
- Onboard the sender domain for Email Service. On the Workers Free plan, enabling
  Email Routing on the sender domain and sending only to a verified destination is the
  supported no-cost path; sending to arbitrary recipients requires Workers Paid. Do not
  upgrade billing without explicit approval.
- Set `NOTIFY_FROM_EMAIL` to an address on that domain. Notifications use the sender
  display name `Sabio`.
- Add a `send_email` binding named `EMAIL` with `destination_address` set to the owner
  address in the private production configuration only. Do not add it to the public
  preview config.
- Confirm current plan limits and terms. Sending to a verified destination is free on
  Free and Paid plans; arbitrary-recipient sending requires Workers Paid. Do not upgrade
  billing without explicit approval.
- Without the binding or `NOTIFY_FROM_EMAIL`, the Worker silently skips notifications.

## Deployment gate — requires explicit owner scope

Agree on the account, Worker, HTTPS hostname, owner authentication, D1 resources,
allowed Free-plan usage and public/private boundaries. Recheck current provider
terms and account quotas. Do not upgrade billing, connect private sources, authorize
accounts or create resources based only on this document.

After scope is agreed:

1. Recheck the installed Wrangler version/help and current Cloudflare documentation
   for the exact remote operations. Inspect environment inheritance and bindings;
   do not accidentally attach production state to a preview.
2. Provision only the named resources; keep actual IDs, secrets and owner settings
   out of public examples. Generate Env types from the selected configuration.
3. Review migrations, retention and recovery. Back up existing state before changes
   and confirm exactly which environment each migration targets.
4. Set server-side secrets using protected tooling, never chat, command arguments,
   public vars or frontend bundles. Review staged files and packaged artifacts.
5. Review logs, outbound traces and sampling for ZIPs, provider query URLs, cookies,
   pairing codes and personal image URLs. Current traces are deliberately disabled;
   do not enable automatic URL tracing without a redaction review.
6. Repeat local checks and a packaging dry run, then deploy only the approved target.
7. Verify HTTPS assets, owner-authenticated pairing-code generation, display claim,
   weather, settings, denial, expiry and revocation against the actual deployed routes
   from paired and unpaired browsers. Confirm the code expires and cannot be replayed.
   Do not call a deployment secure just because its homepage loads.

The display must work without an always-on Mac or an inbound home-network service.
Public image hosts and the weather provider still receive their respective requests.

## Frame acceptance — separate approved device batch

The frame can stay powered down until a deployed release is ready. The separate
[frame project](../../classic10-charm-dashboard/) owns identity verification,
connection/cleanup, package state and device approval procedures.

Validate Firefox 68 rendering, HTTPS/API support, touch and fullscreen, photo memory
use across an extended run, network loss/recovery, browser restart with saved settings,
and deployed revocation. Check Home/navigation and package states after power-up.
No firmware, USB, root or launcher changes are required by the app release itself.

## Coordinated security audit backlog

Owner requested a comprehensive audit of both deployed Sabio and the physical frame.
It must cover application routes/Access/D1/cache/logging/metadata/photo providers,
owner and display sessions/revocation, plus Android 4.4/Firefox 68, unauthenticated
root ADB, installed apps/permissions, home-network isolation/egress, updates and
USB/recovery. Produce a joined threat model, findings/severity, actionable mitigations
and verified retests. The requested device-side validation requires its own approved,
owner-present batch and existing safety/recovery gates. Do not start that audit by
connecting to/scanning the frame, capturing traffic, changing settings or adding
private account data; this backlog entry authorizes none of those operations.

## Rollback and recovery

Record the previous good Worker version and schema compatibility before release.
A Worker code rollback does **not** restore database contents or undo migrations.
Prefer backward-compatible schema changes; test data recovery separately. Never
restore an old database in a way that silently resurrects revoked credentials.

If authorization fails or sensitive data is exposed, disable affected routes/access,
revoke compromised sessions or credentials, and inspect sanitized diagnostics. Do
not bypass authentication to restore a working-looking dashboard. Disabling access,
rolling back cloud code and restoring data are separate scoped operations.

References: [architecture](architecture.md), [security](../SECURITY.md),
[Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/),
[rollback limitations](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
