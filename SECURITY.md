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

## Your responsibilities as an operator

Running ADDE makes **you** the operator: you drive an AI engine (via its ACP adapter) and, with the
Telegram source, you run a Telegram bot. Some obligations come from those upstream services rather
than from ADDE — surfaced here so you can comply. This is not legal advice; consult each service's
current official terms before relying on it.

- **Upstream engine terms govern your use.** Content you send is passed to the AI engine's provider
  (for the `claude` engine, the [Anthropic API](https://www.anthropic.com/legal/aup); for other
  engines, that engine's provider). Your use is governed by the terms of your own plan with that
  provider — for Anthropic, the [Commercial Terms](https://www.anthropic.com/legal/commercial-terms)
  (paid API) or Consumer Terms (Claude subscriptions) and the [Usage Policy](https://www.anthropic.com/legal/aup).
  ADDE invokes the engine through its official ACP adapter; it does not extract, store, or reuse your
  engine credentials (auth stays in the engine's own config, e.g. `~/.claude`).
- **Disclose that it's an AI.** Provider usage policies generally require consumer-facing chatbots to
  tell people they are interacting with AI. If anyone other than you can reach your bot, make that
  disclosure.
- **Handle other people's data lawfully.** If others can reach your bot (e.g. a shared Telegram
  group), you become responsible for the messages they send through it. Telegram expects bot
  operators to handle user data lawfully; publish a privacy policy and handle their data accordingly
  if you let others use it.
- **Keep the inbound allowlist tight.** The simplest way to limit all of the above is to restrict who
  can reach the bot — keep the Telegram inbound allowlist (`chat_id` / `from`) to yourself or people
  you trust, and keep the lane permission policy (`perm_tier`, `allowlist`, `hard_deny`) as narrow as
  the task needs.
- **Mind the sync surface (Markdown source).** With the Markdown source, instructions, approvals, and
  AI output are written to notes that your syncing vault replicates to third-party sync
  infrastructure — see [Markdown guide — exposure of sensitive data](docs/markdown.md#syncing-vaults-and-exposure-of-sensitive-data).

> ADDE is an unofficial, third-party tool not affiliated with or endorsed by Anthropic; "Claude" and
> "Claude Code" are trademarks of Anthropic. Other engine and platform names are trademarks of their
> respective owners.
