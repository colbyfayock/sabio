# Architecture and implementation direction

Status: **LOCAL MOCK executable milestone** implemented; the authorization and
integration architecture below is proposed design, not an implemented security
guarantee. No remote deployment is authorized or implied.

## Current local implementation

Wrangler runs the Worker before asset handling (`run_worker_first`); there is no SPA
fallback. The Worker exposes public synthetic JSON at `/api/demo` and public `/health`;
`/api/display` returns 401 independently of fake cookies. `/api/enrollment`, `/api/admin`,
`/admin`, and `/auth` subpaths return 503. Unknown API and static paths return 404
before the asset binding. The public static allowlist is HTML, CSS, app JavaScript, and
favicon. There are no backend/provider-data/storage bindings or credentials.

The IIFE frontend targets Firefox 68 at build time but is not validated on actual
Firefox 68 hardware. It shows synthetic weather, agenda, and checklist data using the
browser-local clock. It polls every 60 seconds with a 12-second timeout and backoff up
to five minutes; checkbox state is in memory. Retry/offline/stale states retain the
existing display, and fullscreen requires a user gesture. No new real-hardware test
was performed; the separate frame project's older compatibility fixture is not this
application.

Display location is currently a browser-local city/region label, not a weather API
integration. The weather-card editor saves a validated versioned preference under
`sabio.location.v1` and overrides the sample location label across polls. It never
submits the label, uses GPS, or geocodes. Reset removes only the owned key; blocked
storage falls back to in-memory state with a visible warning. This is not server
storage, an authenticated preference, or protected personal data. Provider-backed
location search/forecast and trusted per-display settings remain future work.

Local workflow: `pnpm install --frozen-lockfile`; `pnpm check` generates ignored
environment types, typechecks Worker and frontend, builds, and runs Node unit tests.
`pnpm dev` builds then starts Wrangler locally at `127.0.0.1:8787`. Frontend edits
require another `pnpm build`; Wrangler handles Worker edits. `pnpm build:worker` is a
local deploy dry run/package only. The build refuses unexpected `dist` files rather
than removing unknown work. There is no direct deploy script; remote deployment,
resource creation, and billing changes are not authorized. Wrangler authentication
is managed locally, and `whoami` output is private; account authentication does not
authorize deployment. Never send private data to this public mock, even after CLI login.

## Goals and boundaries

Host an owner-controlled dashboard on Cloudflare without requiring an always-on home
server. Support individually approved display browsers and selected real data sources.
Start with public/mock data; add private integrations only after authorization tests.

Frame provisioning, raw storage, root access and recovery belong in
[the separate frame setup project](https://github.com/colbyfayock/classic10-charm-dashboard).
Do not move its diagnostics, private records, or compatibility fixture into Sabio.

## Components

### Display frontend

- Legacy-compatible HTML/CSS/JavaScript with an explicit Firefox Android 68 target.
- One same-origin combined data endpoint with modest polling, backoff and visible
  stale/offline status. Request timeouts and upstream failure must not blank the UI.
- User-gesture DOM fullscreen with an escape control; do not assume automatic
  fullscreen or reboot startup. Preserve independent device navigation controls.
- No provider secrets, primary account login, device fingerprints, or personal data
  embedded at build time. A public static shell can exist; private data cannot be
  served until authenticated. Shell caching must not cache private responses.

### Cloudflare Worker

- Serves assets and APIs; use routing that cannot bypass private-data authorization.
- Fetches permitted upstream data, filters unnecessary fields, and caches it with
  appropriate tenant/display separation. Fail closed on authentication/storage errors.
- Keeps API secrets server-side using Cloudflare secrets, not checked-in vars or
  frontend environment variables. Connected OAuth tokens require a separate storage,
  encryption/key-management and refresh/revocation design before implementation.
- Is not an arbitrary URL proxy. Restrict integration destinations and guard redirects,
  request volume, parsing and payload size. Untrusted strings must not become markup.

### Storage

- D1 is the initial candidate for display registrations, bounded enrollment state,
  hashed high-entropy session credentials, revocation and non-secret configuration.
- Resolve schema, consistency and atomic one-time enrollment consumption before
  coding. Minimize stored personal data and define retention/deletion behavior.
- Avoid Workers KV as the sole authority for immediate revocation/one-time pairing:
  its eventual consistency needs explicit treatment, not assumptions.
- Cache public weather separately from private calendar/display responses. No
  cross-user shared-cache leaks. Do not log cookies, codes, auth headers, tokens,
  calendar contents or raw upstream responses.

## Proposed enrollment flow

1. A new browser obtains a short-lived pending enrollment and displays a pairing code.
   It must also hold a separate unguessable enrollment credential; the display code
   alone must not let a different browser claim an approved session.
2. The owner authenticates on a trusted modern device and approves that exact request.
   Cloudflare Access is a candidate for admin authentication, not a proven integration.
   Verify its signed identity token server-side and restrict the actual administrator.
3. The original pending browser completes enrollment exactly once. Use high-entropy
   random credentials, hashed storage, explicit expiry, attempt limits, request
   throttling and atomic state changes; do not exchange secrets in URL query strings.
4. Issue a scoped Secure/HttpOnly session cookie with appropriate SameSite behavior
   and CSRF protection for enrollment/admin state changes. Check validity, expiry,
   revocation and assigned display scope on every private-data request.
5. The owner can list/revoke individual display sessions. Set finite lifetimes and
   decide renewal/rotation rules before claiming unattended operation.

This approves **a browser credential**, not a physical device. A copied credential
can impersonate its browser, especially on a root-accessible frame. MAC addresses,
serial-number strings, user agents and home public-IP allowlists do not prove identity.
Do not assume modern WARP/device posture or login flows work on Android 4.4/Firefox 68.

## Real-data integration sequence

1. Public weather through the Worker; cache and handle provider errors/rate limits.
2. Optional selected calendar with minimum read-only scope, authorized on the trusted
   admin device. Private ICS links are secrets, not public frontend configuration.
3. Optional tasks/other integrations after agreeing display data scope and any writes.

Cloudflare and the upstream providers process the chosen data. The frame can read
anything displayed to it even if master credentials are kept off the device.

## Free-tier operating target

Budget request/CPU/storage/upstream calls for the account, not just one endpoint.
One combined poll/minute is 1,440 daily requests per display before other traffic;
100,000/day and 10 ms CPU/invocation are current Workers Free limits (2026-10-20).
Auth-gated asset routes that invoke the Worker also consume its request allocation.
Handle quota exhaustion safely. No paid services or billing changes without approval.

## Build sequence and acceptance gates

1. **Executable foundation:** pinned tooling, Worker/local preview and legacy display
   shell with mock JSON; automated route/type/build tests. No private data endpoint.
2. **Enrollment/auth:** test deny-by-default, brute-force bounds, expiry, single-use
   races, admin forgery, CSRF, stolen/mismatched enrollment credentials, per-display
   access, rotation, revocation and private-cache behavior before deployment.
3. **Owner-approved mock-only deployment:** verify HTTPS, cookie persistence, pairing
   and fullscreen on the real Firefox 68 device; deny a separate unapproved browser.
   Test default/custom/preview hosts so no alternate route exposes private data.
4. **Public weather integration:** server-side keys if needed, bounded caching and
   clear error/stale states. No account login on the frame.
5. **Private integrations:** agree on minimal displayed fields, data retention,
   OAuth/token handling and additional security requirements first.

Local development and test results are not evidence of deployed protection or real
hardware compatibility. Record exactly what was tested and what remains unverified.
