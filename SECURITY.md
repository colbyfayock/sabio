# Security

Sabio currently has an executable **LOCAL MOCK** application, not a security-ready
service. `/api/demo` and `/health` are public; `/api/display` responds 401 without
validating cookies, and enrollment/admin/auth routes respond 503. Static shell assets
are public. No pairing, authentication, revocation, storage, or real data integration
is implemented. Never send personal data or credentials to this app, including after
authenticating Wrangler locally. Account authentication is not deployment authorization.

The local frontend uses synthetic weather, agenda, and checklist data. Its clock is
browser-local, polling is every 60 seconds with a 12-second timeout and backoff up to
five minutes, checklist state is in memory, and retry/offline/stale states retain
displayed data. Fullscreen requires a user gesture. These behaviors do not establish
security or compatibility on the actual frame.

The initial display target uses obsolete Android/Firefox with existing root access.
The frame is not a trusted store for passwords, provider tokens or sensitive data.
Server-side credentials reduce exposure but cannot hide displayed content from the
display itself. Browser enrollment is not hardware attestation.

The authorization and integration design in [architecture](docs/architecture.md)
remains future work.
The local synthetic fixture contains no real frame change or fixture-based evidence
of the new app on hardware; Firefox 68 compatibility remains unverified. The older
fixture in the separate frame project is not the Sabio application. Local checks or
browser tests are not evidence of deployed protection.

## Reporting

For security vulnerabilities, use this repository's GitHub **Security → Report a
vulnerability** entry if available. If private reporting is not available, open an
issue requesting a private reporting channel without disclosing exploit details,
credentials, endpoints tied to a device, personal data or raw captures.

Never put secrets or personal device/account data in public issues, pull requests,
logs or reproductions. Use synthetic fixtures. Revoke any exposed credential; merely
deleting it from the latest commit does not remove it from Git history.
