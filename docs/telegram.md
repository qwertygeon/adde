_English | [한국어](telegram.ko.md)_

# Telegram (not implemented)

`telegram` is registered as a known [surface](commands.md#bind--manage-channel-bindings) so it appears in `adde doctor` and channel-surface listings, but it is a **stub in this release** — no bot integration, no long-poll, no message delivery. Attempting `adde bind add <proj> <sid> --surface telegram ...` is refused.

- **Discord** is in the same state — registered, stub, no functional integration.
- The only implemented channel today is [markdown notes](markdown.md).
- Driving ADDE from a chat app is a tracked follow-up (see the project's public [Changelog](../CHANGELOG.md) for what ships in a given release).

If you were using ADDE's v0.2.x Telegram integration: v0.2.x settings and data are untouched by v2 (a physically separate config root) but there is no automatic migration path to a v2 project/session yet — see [command reference — migration from v0.2.x](commands.md#migration-from-v02x).
