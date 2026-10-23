# Sabio

An owner-controlled, intelligent dashboard for photo frames and other approved
displays.

## Status

The executable **LOCAL PREVIEW** uses the Horizon layout: time and live Fahrenheit
weather in a left sidebar, with one large photograph on the right. Set a US ZIP for
weather and timezone; configure public image URLs for the slideshow. There is no
calendar, agenda, or checklist. The default preview only enables weather/bootstrap
on loopback. An owner-managed Cloudflare deployment now uses a real Access application,
D1 database and managed Worker. Public-shell, unapproved-browser denial, Access login
redirect and pending-enrollment checks passed against that deployment. Signed-in owner
approval, live authorized weather and revocation still need production verification;
the frame has not been tested. Do not put private account data or credentials into the app.

The first display target is Firefox Android 68.11.0 on a 1280×800 Android 4.4 frame.
The application should also support approved modern browsers. The old frame remains
an untrusted endpoint; root access and obsolete software are not made safe by login.

## Project boundary

- **This repository:** dashboard UI, Cloudflare backend, browser enrollment, device
  access management, and data integrations.
- **[Classic10 Charm frame setup](https://github.com/colbyfayock/classic10-charm-dashboard):**
  frame access, backup/recovery, launcher/navigation setup, device diagnostics, and
  security findings. Its local mock page is a hardware compatibility fixture, not
  the production Sabio application.

## Planned architecture

```text
Weather / selected calendar / other providers
                    |
         Cloudflare Worker + storage
         - Serve compatible frontend
         - Fetch/cache filtered data
         - Keep provider credentials server-side
         - Authorize every private data request
                    |
                  HTTPS
                    |
       Individually approved display browsers
```

No always-on home computer, inbound home-network port, or Cloudflare Tunnel is
required. The display needs internet access. Provider requests and selected data
will be handled by Cloudflare; this is cloud hosting, not local-only processing.

Administration belongs on a trusted modern device. A display shows a short-lived
pairing code for the administrator to approve, then receives a limited, revocable
browser session. Approval identifies a browser credential, **not cryptographic
proof of a physical device**. Main provider credentials never belong on the frame.

See [architecture](docs/architecture.md), [access control](docs/access-control.md),
and [security](SECURITY.md) for implementation boundaries and reporting guidance.

## Free-tier target

Design for Cloudflare Workers Free and D1 free allocations. As checked on
2026-10-20, Workers Free includes 100,000 requests/day and 10 ms CPU per invocation.
One combined display-data poll per minute is 1,440 requests/day per device, before
other traffic. Authentication/storage operations, abuse, CPU, and upstream limits
also matter; remaining on the free tier is a target, not an unlimited-use guarantee.

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

Stay on the Free plan unless the owner explicitly approves otherwise. API providers
and optional domain registration may have separate costs. The owner-approved initial
deployment created one Worker, one D1 database, one admin-only Access application and
one reusable owner policy. No paid upgrade or billing change was made by the deployment.

## Development direction

- TypeScript and ES modules for server code; pinned pnpm tooling.
- Standards-based display UI with an explicit Firefox 68 build/runtime target.
- Mock/public data first; no sensitive account sessions on the legacy frame.
- Test authentication, denial, enrollment expiry, revocation, and private-cache
  behavior before adding personal integrations or publishing private endpoints.

### Local CLI setup

Use Node.js 22.13 or newer and the pinned pnpm 10.23.0. From this repository:

```sh
pnpm install --frozen-lockfile
WRANGLER_SEND_METRICS=false pnpm wrangler --version
```

Wrangler is an exact-pinned development dependency (`4.151.3`), not a global install.
The lockfile pins dependencies/integrities; only the `esbuild` and `workerd` dependency
build scripts are allowed by the pnpm package configuration. The command above opts
out of optional Wrangler metrics for that invocation.

Read-only authentication check:

```sh
WRANGLER_SEND_METRICS=false pnpm wrangler whoami
```

`whoami` can print account/email identifiers; keep its output private. Wrangler login
is managed locally. Account authentication does not itself authorize cloud changes.
There is no automatic public-repo deployment script; owner-local production configuration
is kept under ignored `private/` storage. `pnpm build:worker` remains a local packaging
dry run, not a deployment. Additional cloud changes still require an agreed scope.

## Local development

Run `pnpm install --frozen-lockfile`, then `pnpm check` for generated local types,
Worker and frontend typechecks, build, and Node tests. `pnpm dev` builds and starts
Wrangler locally on `127.0.0.1:8787`; Worker changes are handled by Wrangler, but
frontend edits require `pnpm build` again. The build refuses unexpected files in
`dist` rather than deleting them. Public examples must never contain private account
data; the only approved location submission is the ZIP5 weather request described below.

```sh
pnpm check
pnpm dev
# Open http://127.0.0.1:8787 on this computer.
```

The clock uses browser-local time until a weather response supplies the selected
ZIP's validated IANA timezone. The UI labels this fallback explicitly; after a
successful lookup, the clock, date, and automatic theme use that timezone, including
daylight saving time. A failed refresh for the same ZIP retains the resolved timezone;
changing/resetting the ZIP clears it. The timezone is currently in memory: an offline
reload falls back to labeled browser time until a lookup succeeds again.

`/health` is public and identifies this as a preview without authentication.
The old `/api/demo` endpoint has been removed. Weather loads through `POST /api/weather` when a ZIP is
saved, refreshes every 10 minutes, and retries with backoff up to 30 minutes. It has
its own 12-second browser timeout, shows timestamps/stale status, and does not fall
back to sample weather. In preview, `/api/display` returns 401 and enrollment/admin
remain unavailable. Preview bootstrap/weather refuse non-loopback origins. Managed
mode requires complete origin/owner configuration and D1; valid display sessions
are required for weather, with server-side revocation and abuse limits. Unknown
API/static routes return 404 before asset fallback. The managed path is locally
tested, not a claim of deployed security or approval for private integrations.

### Local access-control testing

The checked-in D1 ID is an all-zero **local placeholder**, not a provisioned database.
`remote: false` selects local development storage; it is not a deployment guard by
itself. `APP_MODE=preview`, empty owner variables, disabled public preview URLs and
non-loopback preview denial keep the checked-in app unconfigured for public use.

```sh
pnpm db:migrate:local
pnpm check
```

The migration command explicitly targets local state. Tests also run the actual
schema against SQLite and isolated, nonpersistent local D1 with remote bindings
disabled. No test calls Cloudflare account APIs or needs a real owner login.
See [access control](docs/access-control.md) before configuring managed mode.

### Photos and appearance

- **Photo source** accepts 1–12 public HTTPS image URLs, one per line, and a whole-number
  hold of 10–3600 seconds. The default is 20 seconds plus a 1.2-second transition.
  **Use samples** fills the editor with the built-in Unsplash images; Save applies it.
- Photo URLs and hold duration are stored only in this browser under `sabio.photos.v1`.
  These are not private URLs or secrets: hosts receive direct image requests and ordinary
  network metadata. Referrers are suppressed. There is no server-side image proxy,
  file upload, cloud-album sync, or authenticated remote settings service.
- Use reasonably sized JPEGs (about 1200 pixels wide) for the frame. Source count and
  URL length are bounded, but image host availability and decoded image size are not
  controlled by Sabio. HTTPS/no-login/local-address checks are syntax checks, not a
  guarantee about DNS or redirects. Do not use sensitive links or access tokens.
- Two image layers preload a replacement before fading. Failed images are skipped;
  if every source fails, the last good image remains and retries are bounded. Pause
  stops automatic rotation, Next advances manually, and hidden pages stop rotation.
  Reduced-motion users get immediate transitions. Pause state is visit-only.
- **Appearance** saves Auto/Light/Dark under `sabio.appearance.v1`. Auto is light
  07:00–18:59 and dark 19:00–06:59 in the displayed timezone, not sunrise/sunset.
- Blocked browser storage produces visible visit-only notices instead of breaking
  the dashboard. Settings do not sync between browsers. Fullscreen requires a gesture.

### Owner display details

The protected owner session list lets the owner assign an optional display name, such
as “Living room frame”. The name is only an organizational label—not identity,
authentication or device attestation. It is stored on that display's D1 record; clear
the field to remove it. Names are limited to 80 characters, reject markup/control
characters, and are rendered as plain text. Revoked sessions remain in a collapsed
**Show revoked sessions** history until normal expiration; they show a revocation time
and have no active rename/revoke controls.

The session list also shows an approximate device category, parsed browser/OS version,
and last check-in. Those labels come from the User-Agent header, can be spoofed, and
are not hardware identity or an authorization factor; the raw header, IP address,
model and serial are not stored. Check-in details update at most every five minutes.

After a successful managed weather lookup, Sabio stores the last resolved city/region,
timezone and timestamp on that display's D1 record for the owner list. It does not store
the submitted ZIP, forecast coordinates, GPS or IP-derived location for this purpose.
The value is a **last weather area**, not a physical/current-location claim, and remains
as historical context after ZIP reset or failed weather lookups. It expires with the
  display record. Only the authenticated owner admin list can read it; it is not returned
  to displays as extra metadata. Treat this as location-related owner data. These fields
  are now deployed in D1 migration 0002; existing browsers populate them on their next
  managed bootstrap and successful weather lookup without re-pairing. Display names
  are now deployed in additive migration 0003.

### Weather ZIP code

Use **Set ZIP code** on the weather card to enter a US ZIP code: five digits or
ZIP+4. Leading zeros are preserved. The choice stays in this browser's local storage
and survives refreshes; **Change ZIP code** reopens the editor, and **Reset ZIP code**
removes only Sabio's location preference.
If browser storage is unavailable, the UI explains that the choice lasts only for
the current visit. Cancel/Escape leave the saved choice unchanged.

Saving a ZIP requests live weather. The browser stores the entered value locally
and sends only its first five digits in the JSON body of
`POST /api/weather` (not the URL). The Worker geocodes through Open-Meteo, requires an
exact US postcode match, then requests a Fahrenheit forecast. It validates provider
responses and freshness, and uses a best-effort 10-minute public cache keyed by a
SHA-256 hash of the ZIP5. That hash is not anonymous or secret. The Worker has no
cookies, authentication, calendar access, or private-user records on this route.

Open-Meteo receives the ZIP5 for geocoding and the resulting coordinates for forecast
requests, along with ordinary network metadata. Local development requests originate
from the Mac; cloud hosting is not a promise of anonymity. Its terms state that
provider logs may retain coordinates for up to 90 days:
[Open-Meteo terms](https://open-meteo.com/en/terms). The current free API is for
non-commercial use, subject to published request limits (10,000/day, 5,000/hour,
600/minute); commercial use requires an appropriate paid plan and separate owner
approval. Open-Meteo data uses CC BY 4.0; GeoNames attribution is shown in the UI.
No API key is used. Provider/cache availability is best effort, not guaranteed.

No GPS is requested. Browser-local storage is not secret storage or protection from
root access to the display. Old city-label records are not interpreted as ZIP codes;
explicitly saving replaces the owned record with the ZIP schema, and Reset removes it.

### Validation status

- Node tests cover owner JWT signature/claims, original-browser pairing, one-time
  consumption, expiry, revocation, CSRF, rate limits, routing/denial, response policy, weather provider/request/cache
  and timezone validation, text-only rendering, weather backoff/timeouts/offline
  recovery, photo preferences/loading/races/retries, timezone/DST/theme boundaries,
  and fullscreen state/error handling. Cleanup regression tests assert that invalid
  display/pending credentials and rejected enrollment attempts trigger no cleanup
  batches, and that cleanup and bootstrap-polling stay bounded. These are unit tests,
  not old-browser emulation.
- ZIP tests cover ZIP5/ZIP+4 syntax, leading zeros, old city-record handling, storage
  errors, persistence across refresh, cancel/reset/focus, and the location request flow.
- Actual local `workerd` smoke checks passed for asset/API/error routes, including a
  live weather response for a public reference ZIP (not an owner's location).
- Horizon was checked in local Chromium at 1280×800 in both themes and at 390 pixels.
  Browser checks cover sample image loading, pause/next, URL validation, photo settings
  across reload, focus restoration, ZIP entry, and mocked weather/timezone rendering.
  Axe checks report zero violations for both themes, the photo dialog, mock admin UI
  and approval gate; the gate has one manual contrast incomplete. This is not a
  complete accessibility certification or evidence of old-browser compatibility.
- Initial managed deployment checks passed for HTTPS shell/headers, bootstrap denial,
  forged-session rejection, protected admin redirects, CSRF rejection, pending enrollment
  and private-file/static-fallback denial. A real browser saw the approval gate before
  any photos/weather loaded. Owner-login completion and frame/Firefox-68 validation
  remain unverified; local auth tests do not substitute for those checks.
- Local D1 migration/test coverage and metadata unit/Worker integration tests cover
  coarse device labels, 5-minute update limits, weather-area timestamping, and excluding
  ZIPs/coordinates/raw User-Agent from stored/displayed details. Metadata feature has
  not yet been migrated/deployed to the production database.
- Admin sessions now show a coarse browser/OS/device-category heuristic updated on
  bootstrap at most every five minutes, and the last city/region successfully resolved
  for weather with its IANA timezone and resolution time. No raw User-Agent, model,
  serial, IP geolocation, GPS, ZIP, or coordinates are stored for these descriptions.
  UA labels are spoofable; they are not identity or device attestation. The last weather
  area is retained as a historical last-resolved value (for example, after ZIP reset)
  so the admin does not imply it is the device's physical/current location. Visible note
  on admin clarifies this. This adds browser-category and approximate location metadata
  to D1, not private photo or account data.
- A coordinated, comprehensive security review of the Sabio service/deployment and
  frame/device OS, root ADB, browser, network, recovery and data-handling boundaries is
  backlog work. It has not been completed and these functional tests are not that audit.
- `pnpm build:worker` packages successfully without upload. GitHub Actions runs the
  install/check/dry-run sequence without Cloudflare credentials or deployment steps.

See the [release runbook](docs/releasing.md) for the remaining production gates.
The requested comprehensive Sabio-plus-frame security audit is backlog work and has
not been completed; see the [access-control/security boundary notes](docs/access-control.md).

## License

[MIT](LICENSE)
