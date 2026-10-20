# Sabio

An owner-controlled, intelligent dashboard for photo frames and other approved
displays. The name is Brazilian-inspired, from Portuguese *sábio* (wise).

## Status

The executable **LOCAL MOCK** milestone is implemented: a local Worker serves a
synthetic dashboard and public mock API. This is not auth-ready: there is no pairing,
authentication, private data path, or live integration. Do not put personal data or
credentials into the app, even if Wrangler is authenticated locally.

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

See [architecture](docs/architecture.md) for the implemented local mock boundary and
future trust boundaries, and [security](SECURITY.md) for reporting guidance.

## Free-tier target

Design for Cloudflare Workers Free and D1 free allocations. As checked on
2026-10-20, Workers Free includes 100,000 requests/day and 10 ms CPU per invocation.
One combined display-data poll per minute is 1,440 requests/day per device, before
other traffic. Authentication/storage operations, abuse, CPU, and upstream limits
also matter; remaining on the free tier is a target, not an unlimited-use guarantee.

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

Stay on the Free plan unless the owner explicitly approves otherwise. API providers
and optional domain registration may have separate costs. No Cloudflare resources
or billing changes have been made for this project.

## Development direction

- TypeScript and ES modules for server code; pinned pnpm tooling.
- Standards-based display UI with an explicit Firefox 68 build/runtime target.
- Mock/public data first; no sensitive account sessions on the legacy frame.
- Test authentication, denial, enrollment expiry, revocation, and private-cache
  behavior before adding personal integrations or publishing private endpoints.

### Local CLI setup

Use Node.js 22 or newer and the pinned pnpm 10.23.0. From this repository:

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
is managed locally. Account authentication does not authorize deployment or resource creation.
There is no direct deploy script or approval for remote deployment, resource creation,
or billing changes. `pnpm build:worker` is a local packaging dry run, not a deployment.

## Local development

Run `pnpm install --frozen-lockfile`, then `pnpm check` for generated local types,
Worker and frontend typechecks, build, and Node tests. `pnpm dev` builds and starts
Wrangler locally on `127.0.0.1:8787`; Worker changes are handled by Wrangler, but
frontend edits require `pnpm build` again. The build refuses unexpected files in
`dist` rather than deleting them. Public examples and this mock app must never contain
private data.

```sh
pnpm check
pnpm dev
# Open http://127.0.0.1:8787 on this computer.
```

The mock UI uses the browser-local clock and synthetic weather, agenda, and checklist
content. It polls every 60 seconds with a 12-second timeout and backoff up to five
minutes; checkboxes are in-memory only. Retry/offline/stale-data states retain displayed
data, and fullscreen requires a user gesture. Static HTML, CSS, app JavaScript, and
favicon are public; `/api/demo` and `/health` are public, `/api/display` returns 401
regardless of fake cookies, enrollment/admin/auth routes return 503, and other API or
static misses return 404 before asset fallback. There are no backend, provider-data,
storage, or credential bindings. Do not treat any route as protecting personal data.

### Weather ZIP code

Use **Set ZIP code** on the weather card to enter a US ZIP code: five digits or
ZIP+4. Leading zeros are preserved. The choice stays in this browser's local storage
and survives refreshes; **Change ZIP code** reopens the editor, and **Reset ZIP code**
removes only Sabio's location preference.
If browser storage is unavailable, the UI explains that the choice lasts only for
the current visit. Cancel/Escape leave the saved choice unchanged.

This is a **display label only**: the forecast remains synthetic. There is no GPS
request, geocoding, automatic weather lookup, or ZIP submission to the Worker or
another service. Browser-local storage is not secret storage or protection from root
access to the display. Old city-label records are not interpreted as ZIP codes;
explicitly saving replaces the owned record with the ZIP schema, and Reset removes it.

### Validation status

- 33 Node tests cover routing/denial, response policy, payload validation, text-only
  rendering, poll backoff/timeouts/offline recovery, in-memory tasks, and fullscreen
  state/error handling. These are unit tests, not old-browser emulation.
- ZIP tests cover ZIP5/ZIP+4 syntax, leading zeros, old city-record handling, storage
  errors, persistence across refresh, cancel/reset/focus, and local-only changes.
- Actual local `workerd` smoke checks passed for 11 asset/API/error routes.
- Local Chromium checks passed for 1280×800 layout, fullscreen entry/exit, checklist
  preservation after refresh, failed-refresh data retention, and a 390-pixel layout.
- Automated desktop accessibility checks reported zero violations and no incomplete
  checks after contrast fixes. This is not a complete accessibility certification.
- The location dialog was checked on desktop and a 320-pixel viewport, including
  fullscreen, Enter/Escape, focus isolation/restoration, and save/reset persistence.
  Its automated check reports no violations; an overlay contrast check remains manual
  (the input hint's computed foreground/background ratio is approximately 4.96:1).
- No remote deployment or new frame/Firefox-68 hardware test has been performed.
- `pnpm build:worker` packages successfully without upload. GitHub Actions runs the
  install/check/dry-run sequence without Cloudflare credentials or deployment steps.

## License

[MIT](LICENSE)
