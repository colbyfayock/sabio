# Sabio

An owner-controlled, intelligent dashboard for photo frames and other approved
displays. The name is Brazilian-inspired, from Portuguese *sábio* (wise).

## Status

Project foundation and architecture only. There is no deployed service, implemented
device pairing, authentication, or live data integration yet. Do not upload personal
data or credentials assuming access controls already exist.

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

See [architecture](docs/architecture.md) for the proposed trust boundaries and
implementation sequence, and [security](SECURITY.md) for reporting guidance.

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

- TypeScript and ES modules for server code; pnpm when packages are introduced.
- Standards-based display UI with an explicit Firefox 68 build/runtime target.
- Mock/public data first; no sensitive account sessions on the legacy frame.
- Test authentication, denial, enrollment expiry, revocation, and private-cache
  behavior before adding personal integrations or publishing private endpoints.

There are no install, test, or deployment commands yet; executable scaffolding is
the next implementation step. Public code/examples must never contain private data.

## License

[MIT](LICENSE)
