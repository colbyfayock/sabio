# Access-control implementation

Status: **locally tested managed-mode code, deployed and partly verified**. The checked-in
configuration stays `APP_MODE=preview`, uses an all-zero local D1 placeholder, and
has no owner/origin configuration. A separate ignored owner-local production config
binds the real D1 database, managed Worker and admin-only Access application. Its
reusable policy allows only the selected owner's Cloudflare login email. Remote checks
of the earlier display-initiated flow covered unapproved denial, login redirects,
CSRF, pending enrollment, owner approval, authorized weather and revocation. The
source now uses owner-initiated pairing; that flow is locally tested but not deployed.
The cleanup cron, Access token lifetime, log redaction and hardware remain unverified.
Do not connect private data or treat this document as authorization for additional
cloud changes.

## Modes and trust boundaries

- Preview serves the public shell and permits bootstrap/weather only on loopback.
  Fake cookies cannot enable managed behavior. Pairing and administration remain
  unavailable. No preview bypass is allowed on a public hostname.
- Managed mode requires `APP_MODE=managed`, exact HTTPS `APP_ORIGIN`, a valid
  `ACCESS_TEAM_DOMAIN`, 64-character application `ACCESS_AUDIENCE`, `OWNER_EMAIL`
  and D1 binding. Optional `APP_ALLOWED_ORIGINS` is a comma-separated list of up to
  four exact HTTPS origins; it must contain `APP_ORIGIN`. Each allowed host is
  independently checked on managed routes. Missing/invalid config denies managed APIs.
- Public shell, CSS and JavaScript contain no owner settings or credentials.
  `/api/bootstrap` reports whether this browser is enrolled, without returning its
  credential. The frontend waits for bootstrap before starting photo/weather loads and
  keeps the dashboard shell hidden until bootstrap confirms preview or a paired
  managed session. Shell visibility is a UI boundary, not authorization; protected
  APIs still enforce the display session on every request.
- Administration belongs behind a real Cloudflare Access application protecting
  `/admin` and `/api/admin/*`. Display pairing/API paths must not require that
  modern owner login on the legacy frame. Configure these policies explicitly and
  test their interaction on the chosen hostname. Owner-local setup created a reusable
  policy and one application with these two path destinations before publishing the
  Worker; no account-wide Access rule was enabled.

## Owner authentication

The Worker verifies `Cf-Access-Jwt-Assertion` with pinned `jose`, allowing RS256 only.
Keys come from the configured team's fixed `/cdn-cgi/access/certs` URL, never an
issuer or key URL supplied in an untrusted token. Certificate responses are bounded,
time-limited, reject redirects, and optionally cache public keys for five minutes.
Signature, issuer, audience, expiry, not-before/issued-at, application token type,
nonempty subject and configured owner email are checked. Plain email headers and
service tokens do not authenticate the owner. No owner password is stored by Sabio.

## Owner-initiated pairing and sessions

1. The owner authenticates at `/admin` and explicitly requests a one-time code with
   `POST /api/admin/pairing {}`. The Worker creates a pairing record with a random
   ten-character code and returns the code once; only its SHA-256 hash is stored. The
   code expires after ten minutes. A new owner-issued code expires any older unclaimed
   owner code, so only the newest stays valid. The code is a bearer secret: generate it
   only while pairing a display you control and enter it promptly.
2. The unapproved display submits `POST /api/enrollment/claim { code }` as same-origin
   JSON. There is no public display-initiated enrollment or approval endpoint. The code
   is normalized to uppercase; invalid, expired and replayed codes return 401. Claim
   attempts are rate-limited before the code lookup. The ten-character alphabet provides
   roughly 50 bits of entropy, but the code is still exposable by shoulder-surfing,
   phishing or a compromised admin browser.
3. An atomic D1 batch consumes the pending pairing record, creates exactly one display
   record and one session, and clears the code hash. Concurrent claims create at most
   one session. The code has no standing authority until claimed. The claim query
   requires `pending_hash IS NULL`, so legacy display-initiated pending rows from the
   previous flow cannot be redeemed through the owner flow.
4. On success the browser receives a random 256-bit `__Host-sabio_display` cookie; only
   its hash is stored. The cookie is Secure, HttpOnly, SameSite=Strict, Path=/ and has
   no Domain attribute. Duplicate credentials deny. No pending browser cookie is issued.
5. A display session is a seven-day idle window, not a fixed 30-day lifetime. While a
   paired display keeps checking in, bootstrap slides the window forward at most once
   per day and reissues the same Secure/HttpOnly cookie with a fresh `Max-Age`, so an
   active display does not need to pair again. Seven days without an authenticated
   request expires the session and requires pairing. There is no absolute lifetime cap:
   a continuously active credential can keep renewing, so revocation is the control for
   a lost or copied credential. `GET /api/display` returns only this session's display
   ID and expiry. Unknown display subroutes cannot select another display.
6. Owner-only session listing and `POST /api/admin/revoke { id }` revoke a browser.
   Every protected request rechecks server state. Online displays also recheck
   bootstrap once a minute and reload into the pairing gate on denial.
7. When the optional owner notification is configured, the Worker sends one email after
   the session batch succeeds. Replayed, invalid, expired and rate-limited claims send
   nothing. The payload is limited to the event time, display ID, a coarse browser/OS
   label, approximate network location (city/region/country only, not persisted by
   Sabio) and the dashboard URL; see [releasing](releasing.md). Delivery failure never
   blocks pairing.

Admin metadata is descriptive only: the server parses a short browser/OS/device-type
label from the untrusted User-Agent and saves no raw header. It is updated through
bootstrap no more often than every five minutes. User-Agent strings can be absent or
spoofed; this is not identification or attestation. On successful weather lookup, the
Worker saves the last resolved public city/region label and IANA timezone to the display
row; it does not store the submitted ZIP, coordinates, GPS or inferred IP location for
this feature. The record contains an update timestamp. Failed lookups do not overwrite
it, and ZIP reset currently leaves it as historical **last weather area** until another
successful lookup. Only the authenticated admin list returns these values; they are not
in the display bootstrap payload. Additive migration 0002 and its Worker update are
deployed; existing sessions are not invalidated and populate on their next check-in /
successful weather lookup. The authenticated owner may assign an optional display name
of up to 80 characters, stored in migration 0003 and safely rendered as text; blank
clears it. Markup/control characters are rejected. Names are organizational labels
only, never identity proof. Revoked sessions remain in a collapsed admin history until
expiry, with their revocation timestamp and no active controls, as a minimal audit trail.
Treat the area as location-related owner data.

Revocation prevents future protected API access; it cannot erase content already
seen, invalidate a public photo URL, or control an offline/root-accessible endpoint.
The current photo/location/appearance settings are still browser-local, not remotely
managed D1 records. No private display content is implemented.

## CSRF, abuse and retention

Access routes require an exact configured request origin/host and reject query or
encoded-path alternatives. State changes require JSON, an exact Origin header and
bounded bodies. SameSite cookies complement these checks, not replace them. If multiple
hostnames are configured, session cookies remain host-only: a paired display using
one hostname does not transfer its cookie to another and must pair there separately.

Rate budgets are atomic D1 counters with fixed windows:

| Operation | Budget |
| --- | --- |
| Create owner pairing code | 10/minute for the single owner |
| Claim pairing code | 20/minute/client IP, 200/minute globally |
| Verify owner token | 30/minute/client IP, 200/minute globally |
| Owner mutations | 30/minute for the single owner |
| Poll bootstrap | 12/minute/paired display |
| Fetch weather | 6/minute/paired display |

Client IP comes from Cloudflare's `CF-Connecting-IP`, not arbitrary forwarded headers;
missing/invalid values deny pairing claims and owner verification. Hashes are not
anonymous: the rate keys hash IPs with fixed domain-separation strings, not a secret
salt. Global limits bound work but can deliberately trade availability for cost
protection under distributed abuse. These app limits do not substitute for a
deployment-level traffic/quota review or guarantee that a Free-plan budget cannot be
exhausted.

Cleanup never runs for unauthenticated, invalid or rejected requests. A bounded
six-statement batch (at most 25/50 rows per statement) runs only after a pairing claim
succeeds or an owner is verified, and a scheduled trigger runs the same batch every
15 minutes so retention does not depend on traffic. Expired rows are already denied by
every authorization query, so cleanup only reclaims storage. Expired unclaimed pairing
records, old rate windows and expired session/display records are removed in
foreign-key-safe order. Revoked displays remain listed until expiry. Consumed pairing
rows remain while referenced by their display, then expire with it. Additive migration
0004 adds `expires_at` indexes for the display and pairing scans; the scheduled trigger
takes effect on the next owner-approved deployment.

## Validation and remaining release gates

Tests use the real SQLite schema, synthetic RSA-signed JWTs, and an isolated local
D1 runtime with remote bindings disabled. They cover wrong owner/issuer/audience,
forgery, owner-issued pairing, code expiry/invalidation, concurrent one-time
consumption, replay, revocation, CSRF, cross-host denial, rate limits, storage failures
and browser gates. An integrated Worker test exercises signed owner pairing through
protected weather and revocation. These are not tests against an actual Access account
or deployed D1.

Before release: configure/approve the real Access application and owner identity,
resource bindings and canonical HTTPS hostname; review production logs/quotas;
validate deployed denial/revocation and legacy browser cookies; test extended frame
runtime and recovery. D1 configuration must preserve the tested consistency and
atomic batch semantics; do not assume replica reads prove immediate revocation.
Follow the [release runbook](releasing.md).

The separately requested broad Sabio+frame security audit is still backlog work;
this code review and release smoke test are not that audit.

References: [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/),
[application claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/),
[D1 batch semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
