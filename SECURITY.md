# Security

Sabio is currently a design foundation. Authentication, pairing, revocation and data
integrations are not implemented. Do not deploy personal data behind placeholder
routes or assume a private URL provides authorization.

The initial display target uses obsolete Android/Firefox with existing root access.
The frame is not a trusted store for passwords, provider tokens or sensitive data.
Server-side credentials reduce exposure but cannot hide displayed content from the
display itself. Browser enrollment is not hardware attestation.

## Reporting

For security vulnerabilities, use this repository's GitHub **Security → Report a
vulnerability** entry if available. If private reporting is not available, open an
issue requesting a private reporting channel without disclosing exploit details,
credentials, endpoints tied to a device, personal data or raw captures.

Never put secrets or personal device/account data in public issues, pull requests,
logs or reproductions. Use synthetic fixtures. Revoke any exposed credential; merely
deleting it from the latest commit does not remove it from Git history.
