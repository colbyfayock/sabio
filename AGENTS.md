# Agent instructions

Sabio is a public dashboard application, not a device-unlocking or firmware project.
Read `README.md`, `docs/architecture.md`, and `SECURITY.md` before changing the design.
Read the user's `DEVELOPMENT.md` when developing code. Do not perform ADB, package,
settings, network-policy, or firmware changes from this repository; use the separate
frame project's guarded workflow and explicit owner approvals.

## Development

- Use TypeScript, ES modules, semicolons, and pnpm. Match existing quote conventions.
- Keep browser output compatible with Firefox Android 68; test real capabilities,
  not just a minification target. Do not assume modern login, CSS, or Web APIs work.
- Keep the frontend small and dependency-light for 1280×800 and about 1 GB device RAM.
- Bind local development services to loopback by default.
- Prefer focused tests over new infrastructure; test critical auth/data boundaries.
- Use simple lowercase, focused commits. No emojis in code or documentation.
- Use bounded smaller-model delegation when helpful; do not parallelize live-device
  control or share private artifacts with agents unnecessarily.

## Authorization and privacy

- Current repository includes an executable public LOCAL MOCK, not a working
  authentication service. Never label pairing, access control, or real integrations
  implemented without tests; never send private data to the mock.
- Deny unapproved display data requests. Check authentication/authorization on every
  private route, including alternate hosts, asset fallbacks and direct API calls.
- Store provider credentials server-side. Do not place secrets in browser bundles,
  URLs, public Git history, screenshots, logs, example configuration, or build output.
- An opaque session should use Secure/HttpOnly cookies and server-side revocation;
  do not claim it is hardware-bound or protected from root access to the frame.
- Protect enrollment/admin operations, bound attempts and lifetimes, and prevent
  CSRF. Do not use a short pairing code as the long-term display credential.
- Keep per-display scopes narrow and default to read-only. Write integrations need
  a separate authorization design and owner approval.
- Private data must not enter shared unauthenticated caches or static assets. Test
  cross-device access denial and ensure revocation actually takes effect.
- Treat provider content as untrusted data; escape it rather than injecting HTML.
- No credentials, device identifiers, account/calendar IDs, real schedules/photos,
  private feed URLs, database dumps, or access tokens in tracked examples/fixtures.
- Ignored files are not a security boundary. Review every staged file before push.
- No deployment, paid-plan upgrade, billing change, production migration, account
  authorization, or real data-source connection without an explicit owner scope.

## Screenshots

Use mock data for UI testing. Keep captures in ignored owner-only project storage,
inspect them, then delete the exact image/sidecar in the same cycle. Never sweep
unknown files, retain screenshots by default, or publish sensitive display content.
The separate frame repository owns its ADB capture helper and hardware records.
