# Architecture and implementation direction

Status: **LOCAL PREVIEW** implemented with the selected left-sidebar Horizon UI,
live public Fahrenheit weather/timezone and browser-local slideshow configuration.
Managed owner verification, owner-issued pairing, sessions and revocation are
implemented and locally tested. The checked-in default stays unconfigured. A separate
owner-approved managed deployment has real Access/D1 resources and passed earlier
denial/redirect/pending checks, but it still serves the display-initiated approval flow.
Owner-initiated pairing is not deployed; signed-in owner flows and hardware still need
validation. Private integrations remain future work; this is not standing authorization
for more cloud changes.

## Current local implementation

Wrangler runs the Worker before asset handling (`run_worker_first`); there is no SPA
fallback. The Worker exposes public `/health` and `POST /api/weather`, which is
unauthenticated only in the loopback preview. `/api/demo` has been removed. In default preview, bootstrap and
weather are loopback-only; `/api/display` denies access and pairing/admin remain
unavailable. In configured managed mode, D1-backed pairing/session/revocation and
signed owner JWT verification protect the APIs. Unknown API/static paths return 404
before the asset binding. Public assets are the display shell, CSS, app/admin JS and
favicon; `/admin` serves its shell only after owner verification, and direct
`/admin.html` requests are denied. The D1 binding is a local all-zero placeholder,
not a cloud resource. Owner/origin variables are empty by default. The separate real
production config stays ignored under `private/`, with only the six allowlisted
static assets uploaded; no source maps or private setup credentials are deployed.

The IIFE frontend targets Firefox 68 at build time but is not validated on actual
Firefox 68 hardware. Horizon places time/weather in the left 38% and a single
photograph in the right 62%. The clock/date and automatic theme use the ZIP-derived
IANA timezone from the weather response; browser-local fallback is labeled while
unresolved. The timezone remains in memory, not persistent offline state.
There is no agenda/checklist UI or background demo polling. Weather refreshes
every 10 minutes, with a 12-second timeout and backoff up to 30 minutes. The UI shows
timestamps and stale status, clears old data on ZIP change/reset, and has no sample
weather fallback. Fullscreen requires a user gesture. No new real-hardware test was
performed; the separate frame project's older compatibility fixture is not this app.

Display location is a browser-local US ZIP code. The editor saves a version-2
`{ version, zipCode }` preference under `sabio.location.v1`; ZIP5/ZIP+4 syntax is
validated as text to preserve leading zeros, not verified against a postal database.
The browser sends only the first five digits using JSON body `{ zipCode: ZIP5 }` to
`POST /api/weather`; location values in the query string are rejected. The endpoint
requires POST, JSON content type, exactly one string property, and same-origin requests
when an Origin header is present. It has bounded request bodies. Managed mode also
requires the exact Origin, a paired display cookie and a D1 rate budget; preview
omits credentials. There is no calendar access or private weather-provider account.

The Worker geocodes with Open-Meteo, accepts only an exact returned postcode and US
country code, and then requests current conditions and daily high/low with
`temperature_unit=fahrenheit`. It validates response size/shape, units, finite
temperature ranges, and freshness. Provider hosts and request parameters are fixed;
redirects are not followed. Responses are `no-store`, and error/log payloads do not
include ZIP, coordinates, or provider URLs. Outbound traces are disabled to avoid
exporting provider query URLs; production redaction and observability require review.

Open-Meteo receives ZIP5 for geocoding and the resolved coordinates for forecast
requests and ordinary network metadata. The returned forecast includes a bounded,
Intl-validated IANA `timeZone`; missing/invalid provider or cached zones fail closed.
The public weather cache uses version 2, rejecting older payloads without a timezone.
Local development requests originate from
the Mac; cloud hosting is not a promise of anonymity. Its terms state that
coordinates may be retained in provider logs for up to 90 days:
[Open-Meteo terms](https://open-meteo.com/en/terms). A best-effort public Cache API
stores forecasts for 10 minutes under SHA-256-derived area keys; those hashes are
not anonymous or secret. Cache behavior/availability can vary by data center and local
runtime and is not guaranteed. The public forecast cache is separate from managed
session/rate-limit records in D1. No route provisions resources. Open-Meteo's free API is non-commercial only, with published limits of
10,000/day, 5,000/hour, and 600/minute. Commercial use needs an appropriate paid plan
and explicit approval. No API key is used. Open-Meteo data is CC BY 4.0; GeoNames
attribution is shown in the UI.

Old city records are ignored, not guessed into ZIPs, and are replaced/removed only on
explicit Save/Reset. Reset removes only the owned key; blocked storage falls back to
in-memory state with a visible warning. The entered ZIP+4 preference is not stored as
a server-side user setting; the public forecast cache is separate. This is not an
authenticated preference or protected identity. Trusted per-display settings remain future work.

Photo preferences (`sabio.photos.v1`) store 1–12 public HTTPS URLs and a bounded
hold duration locally. Images are requested directly by the browser with no referrer;
the Worker never fetches user-supplied photo URLs. The CSP allows HTTPS images but
keeps scripts/styles/API connections same-origin. URL checks do not guarantee public
DNS resolution or safe redirects, nor constrain decoded image memory. Use small JPEGs,
not sensitive URLs or token-bearing links. No uploads or private album integration.
Two image layers use generation-scoped load/fade callbacks, 15-second load timeouts,
bounded source attempts and delayed retries. Last good photos remain on load errors.
Photo hold, source list and appearance persist; pause is visit-only. Auto appearance
uses 07:00–19:00 in the displayed timezone. Hidden pages stop photo rotation.

Managed bootstrap check-ins update a coarse browser/OS/device-category label derived
from the untrusted User-Agent, at most once per five minutes; raw strings, IPs, model
names and serials are not stored. On a successful managed weather response, D1 stores
the display's last resolved city/region, timezone and timestamp (not ZIP/coordinates/
GPS). It remains historical after reset or failed lookups, and admin labels it as the
last weather area. These approximate descriptions do not identify or attest hardware.
The owner-editable display name is bounded to 80 characters, rendered as plain text,
and never an identity factor. Additive migrations `0002_display_details.sql` and
`0003_display_names.sql` are deployed.

Local workflow: `pnpm install --frozen-lockfile`; `pnpm check` generates ignored
environment types, typechecks Worker and frontend, builds, and runs Node unit tests.
`pnpm dev` builds then starts Wrangler locally at `127.0.0.1:8787`. Frontend edits
require another `pnpm build`; Wrangler handles Worker edits. `pnpm build:worker` is a
local deploy dry run/package only. The build refuses unexpected `dist` files rather
than removing unknown work. There is no automatic public-repo deploy script; the
initial remote setup/deployment was explicitly owner-approved. Further resource or
billing changes are not authorized by this document. Wrangler authentication
is managed locally, and `whoami` output is private; account authentication does not
authorize deployment. Never send private data to this public mock, even after CLI login.

## Goals and boundaries

Host an owner-controlled dashboard on Cloudflare without requiring an always-on home
server. Support owner-issued pairings for display browsers and selected real data sources.
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

Preview weather is a loopback-only public-data exception, not a private-data route or
security approval. Managed weather requires a valid display session and rate budget.
Before deployment, verify the real Access policy, D1/origin configuration, abuse
boundaries and production observability. Location processing is not authorization
to deploy onto or operate a frame.

### Storage

- The local D1 schema implements display registrations, bounded pairing state,
  hashed high-entropy session credentials, revocation and non-secret configuration.
- The tested schema uses atomic batches for one-time claim consumption,
  and bounded expiry cleanup that is admitted-only plus a scheduled 15-minute trigger.
  Validate production consistency, cron deployment and retention before
  enabling it. Browser-local photo/location/appearance settings do not yet sync to D1.
- Avoid Workers KV as the sole authority for immediate revocation/one-time pairing:
  its eventual consistency needs explicit treatment, not assumptions.
- Cache public weather separately from private calendar/display responses. No
  cross-user shared-cache leaks. Do not log cookies, codes, auth headers, tokens,
  calendar contents or raw upstream responses.

## Owner-initiated pairing flow (implemented locally, not deployed)

1. The owner authenticates on a trusted modern device and explicitly requests a
   short-lived pairing code at `/admin`. Cloudflare Access JWT verification is
   implemented server-side with the configured issuer, audience and owner identity.
   Actual Access policies/login remain unverified.
2. The owner enters that code on the unapproved display. The display claims it with a
   same-origin JSON request, and only the code hash is stored. There is no public
   display-initiated request or owner approval step. A newer code invalidates older
   unclaimed codes. Treat the code as a bearer secret until it expires.
3. The claim consumes the pairing record exactly once. Use hashed storage, explicit
   expiry, attempt limits, request throttling and atomic state changes; do not exchange
   secrets in URL query strings. Concurrent or replayed claims must not issue a second
   session.
4. Issue a scoped Secure/HttpOnly session cookie with appropriate SameSite behavior
   and CSRF protection for pairing/admin state changes. Check validity, expiry,
   revocation and assigned display scope on every private-data request.
5. The owner can list/revoke individual display sessions. Use a seven-day idle window
   that renews at most once per day while the display checks in; seven days offline
   requires pairing again, and there is no absolute lifetime cap. See
   [access control](access-control.md) for code and release gaps.

This pairs **a browser credential**, not a physical device. A copied credential or a
copied pairing code can impersonate its browser, especially on a root-accessible frame.
MAC addresses, serial-number strings, user agents and home public-IP allowlists do not
prove identity. Do not assume modern WARP/device posture or login flows work on
Android 4.4/Firefox 68.

## Integration status and future sequence

1. **Implemented locally:** public weather through the Worker, with bounded caching,
   provider-response validation, and visible error/stale states as described above.
2. **Future:** optional selected calendar with minimum read-only scope, authorized on the trusted
   admin device. Private ICS links are secrets, not public frontend configuration.
3. **Future:** optional tasks/other integrations after agreeing display data scope and any writes.

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
2. **Pairing/auth:** test deny-by-default, brute-force bounds, expiry, single-use
   races, admin forgery, CSRF, stolen/mismatched pairing codes or session credentials,
   per-display access, rotation, revocation and private-cache behavior before deployment.
3. **Owner-approved mock-only deployment:** verify HTTPS, cookie persistence, pairing
   and fullscreen on the real Firefox 68 device; deny a separate unapproved browser.
   Test default/custom/preview hosts so no alternate route exposes private data.
4. **Public weather hardening/deployment review:** agree on auth and rate/abuse
   boundaries, production observability/redaction, and provider plan suitability before
   any deployment. Only the loopback preview route is unauthenticated; managed-mode
   controls still need signed-in owner/deployment verification. The initial deployment
   was owner-approved; this document grants no standing deployment authorization.
5. **Private integrations:** agree on minimal displayed fields, data retention,
   OAuth/token handling and additional security requirements first.

Local development and test results are not evidence of deployed protection or real
hardware compatibility. Record exactly what was tested and what remains unverified.
