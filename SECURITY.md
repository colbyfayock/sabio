# Security

Sabio currently has an executable **LOCAL PREVIEW**, not a security-ready service.
`/api/demo` and `/health` are public; `/api/weather` is also public and unauthenticated.
`/api/display` responds 401 without validating cookies, and enrollment/admin/auth
routes respond 503. Static shell assets are public. No pairing, authentication,
revocation, or private-data integration is implemented. Never send personal account
data or credentials to this app, including after authenticating Wrangler locally.
Account authentication is not deployment authorization.

The preview uses synthetic agenda/checklist data and live Fahrenheit weather for a
selected US ZIP. Weather sends only ZIP5 in a same-origin JSON POST body; query
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
uses a 60-second agenda poll; weather refreshes independently every 10 minutes, with
a 12-second timeout and retry backoff up to 30 minutes. Fullscreen requires a user
gesture. These behaviors do not establish security or compatibility on the actual frame.

The initial display target uses obsolete Android/Firefox with existing root access.
The frame is not a trusted store for passwords, provider tokens or sensitive data.
Server-side credentials reduce exposure but cannot hide displayed content from the
display itself. Browser enrollment is not hardware attestation.

The authorization and private-integration design in [architecture](docs/architecture.md)
remains future work. The public weather endpoint is not suitable for deployment as a
security-cleared service: before deployment, agree on authentication, rate/abuse
boundaries, and production observability. It carries location data and is not evidence
of authorization for the frame.
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

## Reporting

For security vulnerabilities, use this repository's GitHub **Security → Report a
vulnerability** entry if available. If private reporting is not available, open an
issue requesting a private reporting channel without disclosing exploit details,
credentials, endpoints tied to a device, personal data or raw captures.

Never put secrets or personal device/account data in public issues, pull requests,
logs or reproductions. Use synthetic fixtures. Revoke any exposed credential; merely
deleting it from the latest commit does not remove it from Git history.
