# Security Policy

## Supported Versions

ADDE is pre-1.0 (`0.x`). Security fixes are applied to the **latest released `0.x`** version only.
Please upgrade to the most recent release before reporting an issue.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Report privately via GitHub Security Advisories:

1. Go to the repository's **Security** tab → **Advisories** → **Report a vulnerability**
   (https://github.com/qwertygeon/adde/security/advisories/new).
2. Describe the issue, affected version, reproduction steps, and impact.

We aim to acknowledge a report within **5 business days** and to agree on a remediation
timeline after triage.

## Disclosure

We follow **coordinated disclosure**: please keep the report private until a fix is released.
Once a patched release is available, the advisory may be published with appropriate credit.

## Scope Notes

ADDE runs an AI engine that can execute tools on the host. Operators are responsible for the
lane permission policy (`perm_tier`, `allowlist`) and the working directory (`cwd`) they grant a
lane. Misconfiguration that grants broader access than intended is an operational concern, not a
vulnerability in ADDE itself — but reports of the permission gate being bypassed **contrary to the
configured policy** are in scope and welcome.
