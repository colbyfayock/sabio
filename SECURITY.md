# Security

Sabio is an executable **LOCAL PREVIEW**, with a locally tested managed access-control
path and an initial owner-managed deployment, not a fully production-validated service.
`/health` and static shell assets are
public. The old `/api/demo` endpoint has been removed. The checked-in preview only
enables bootstrap and unauthenticated weather on loopback; enrollment/admin are
unavailable and display access is denied. Managed mode requires complete owner,
origin and D1 configuration; missing or invalid configuration fails closed.

Managed code verifies signed Cloudflare Access application JWTs against the fixed
configured team's certificates, checks issuer/audience/lifetime and actual owner
email, and rejects plain identity headers. Pairing uses a separate high-entropy
pending-browser cookie and atomic one-time consumption; display sessions are scoped,
revocable and use a seven-day idle renewal. Active displays renew at most once per day;
seven days without a check-in requires pairing again. Weather requires a session in
managed mode. The initial deployment has a real owner-only Access policy/application
and D1 database. Unapproved denial, admin login redirects, pending enrollment, and an
owner-run approval, authorized weather and revocation pass have been verified remotely.
Access token lifetime, the scheduled cleanup run and production logs still need
observation. When enabled, an optional owner email on session issuance contains only
the event time, display ID, coarse browser/OS label and admin URL, never IP, ZIP, raw
User-Agent, cookies or display content. The deployed configuration does not enable it.
No private-data integration is implemented. Never send personal account credentials or
private integrations to this app. Wrangler authentication is not deployment authorization.

The Horizon preview uses public photos and live Fahrenheit weather/timezone for a
selected US ZIP, with no calendar or task data. Weather sends only ZIP5 in a same-origin JSON POST body; query
location values, wrong methods/content types, extra body fields, and cross-origin
requests are rejected. The fixed Open-Meteo integration requires an exact US postcode
match and validates units, finite temperatures, freshness, and response bounds. It
does not follow redirects or accept arbitrary provider URLs. Responses and errors are
generic; application logs do not include ZIPs, coordinates, or provider URLs.

The browser retains full ZIP+4 locally, but submits only the first five digits.
Open-Meteo receives ZIP5 for geocoding and the resulting coordinates for forecast
requests and ordinary network metadata. Local development requests originate from
the Mac; cloud hosting is not a promise of anonymity. Open-Meteo terms
state coordinates may be retained in provider logs for up to 90 days:
[Open-Meteo terms](https://open-meteo.com/en/terms). The best-effort 10-minute public
cache uses SHA-256 area keys; these are not anonymous or secret, and cache availability
is not guaranteed. Browser responses are `no-store`; this does not prevent Cloudflare
or providers from processing the location. Automatic outbound traces are disabled to
avoid exporting provider query URLs. Review production redaction/observability before
any deployment.

The free Open-Meteo API is non-commercial only (published limits: 10,000/day,
5,000/hour, 600/minute). Commercial use requires an appropriate paid provider plan
and explicit owner approval; no billing change is authorized here. No API key is used.
Open-Meteo data is CC BY 4.0 and GeoNames attribution appears in the UI. The browser
does not poll agenda data; weather refreshes every 10 minutes, with
a 12-second timeout and retry backoff up to 30 minutes. Fullscreen requires a user
gesture. These behaviors do not establish security or compatibility on the actual frame.

The initial display target uses obsolete Android/Firefox with existing root access.
The frame is not a trusted store for passwords, provider tokens or sensitive data.
Server-side credentials reduce exposure but cannot hide displayed content from the
display itself. Browser enrollment is not hardware attestation.

The local authorization implementation and remaining gaps are documented in
[access control](docs/access-control.md). Before deployment, verify the real Access
policy, origin, D1 consistency/availability, rate/abuse behavior and observability.
Local tests do not establish deployed protection; remote checks cover only the paths
explicitly described above, not the untested authenticated or hardware flows. The preview weather exception
carries location data and is not evidence of authorization for the frame.
The local synthetic fixture contains no real frame change or fixture-based evidence
of the new app on hardware; Firefox 68 compatibility remains unverified. The older
fixture in the separate frame project is not the Sabio application. Local checks or
browser tests are not evidence of deployed protection.

The location editor stores the user-entered US ZIP in browser-local storage
(`sabio.location.v1`, version-2 ZIP record) when available. It does not request GPS.
It is not an authenticated setting and can be read by the same origin or a compromised
device. Do not treat local storage as a secrets vault. Old city records are ignored,
not converted or submitted; they are replaced/removed only by explicit Save/Reset.
Reset removes only this preference, not other site data; blocked storage may limit the
selection to the current visit. On ZIP change/reset, old weather is cleared; a failed
refresh for the same ZIP retains only the timestamped forecast as stale data. No sample
weather fallback is used.

## Photo and appearance preferences

The browser stores public photo URLs/hold duration under `sabio.photos.v1` and
Auto/Light/Dark under `sabio.appearance.v1`. These are not secrets or authenticated
settings. Never enter private feed links, image access tokens or credentials.
Images load directly from external HTTPS hosts with no referrer, but the hosts can
still observe ordinary network metadata. The Worker does not proxy image URLs.
Syntax checks reject non-HTTPS, credentialed and obvious local-address URLs; they
do not guarantee safe DNS resolution or redirects. Image count and URL length are
bounded, but decoded image memory and host behavior are outside this control.

The CSP permits HTTPS image loads only in its image policy; scripts, styles and
API connections remain same-origin, without inline code or arbitrary fetch access.
No file upload, private photo storage or cloud-album integration is implemented.
Reset ZIP removes only the location preference, not photo or appearance settings.

## Admin display descriptions

The authenticated owner may assign a bounded display nickname. It is owner-entered
organizational metadata, stored with the display record, and never used as proof of
identity or authority. It is limited to 80 characters, rejects markup/control chars,
and is rendered as plain text. Clearing the field removes it; revoked entries remain
in collapsed admin history until normal expiry so the owner can see the revocation time.

Admin lists a coarse browser/OS/device-category guess parsed from the HTTP User-Agent;
the raw value is not stored. This header can be omitted or spoofed, and must never
authorize access or be represented as hardware attestation. A successful managed-mode
weather response saves the last resolved city/region label and IANA timezone for that
display, with a resolution timestamp. It does not save the submitted ZIP, geocoded
coordinates, IP-derived location, GPS, or raw provider response. Failed weather lookup
does not replace the last successful area. ZIP reset does not currently clear this
historical last-resolved label; admin presents it explicitly as the **last weather area**,
not a physical/current-location claim. Browser-check-in is rate-limited in writes to
one update every five minutes. This metadata is attached to the display and visible to
the authenticated owner; it is not included in the display bootstrap response. Display
details and optional owner name are deployed in additive migrations 0002/0003.

## Coordinated security audit backlog

A broad app-and-device audit is still required before relying on Sabio for sensitive
use. Cover the deployed Worker/Access/D1 and routes, enrollment/revocation, caches,
logs, provider metadata, browser-local settings and image URLs together with the actual
frame's unsupported Android/Firefox build, root network ADB, permissions/services,
network isolation/outbound traffic, credentials, recovery and owner data-handling
practices. Include architecture review, threat model, hands-on authorization tests,
bounded device/network review in a separately approved frame batch, mitigations, and
retest. Do not confuse the current targeted tests or brief pre-deployment review with
this audit. The frame project tracks its physical-device portion; this repository
tracks the application/cloud portion.

## Reporting

For security vulnerabilities, use this repository's GitHub **Security → Report a
vulnerability** entry if available. If private reporting is not available, open an
issue requesting a private reporting channel without disclosing exploit details,
credentials, endpoints tied to a device, personal data or raw captures.

Never put secrets or personal device/account data in public issues, pull requests,
logs or reproductions. Use synthetic fixtures. Revoke any exposed credential; merely
deleting it from the latest commit does not remove it from Git history.
