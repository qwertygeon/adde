_English | [한국어](README.ko.md)_

# ADDE User Documentation

This is the ADDE (Ai Driven Development Engine) user guide. For a project overview, see the [root README](../README.md).

## Table of Contents

- [Document list](#document-list)
- [Quick paths](#quick-paths)

## Document list

| Document                                 | Contents                                                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [getting-started.md](getting-started.md) | Install, core concepts (project/session/binding/vault, session states), first project & session, status/diagnostics                                   |
| [markdown.md](markdown.md)               | Driving the AI from markdown notes — grouped palette, notice zone, sending instructions, turn notes, permission approval, stopping/resuming a session |
| [permissions.md](permissions.md)         | The permission gate — tiers (acp/autopass), allowlist/denylist, hard-deny, recommended settings                                                       |
| [commands.md](commands.md)               | Full CLI command and option reference (`project`/`session`/`bind`/`vault`/`factory-reset`, daemon control)                                            |
| [troubleshooting.md](troubleshooting.md) | Diagnosis and remedies by symptom                                                                                                                     |
| [telegram.md](telegram.md)               | Telegram/Discord status (not implemented in this release)                                                                                             |

## Quick paths

- New here → [Getting started](getting-started.md)
- Want to use it from markdown notes (e.g. Obsidian) → [Markdown guide](markdown.md)
- Want to tune what gets auto-approved → [Permissions guide](permissions.md)
- Curious about the commands → [Command reference](commands.md)
- Want to stop a session you're done with, or bring one back → [Markdown guide](markdown.md#stop--ending-the-watch) · [`session stop`/`resume`](commands.md#session-stop--session-resume)
- Something went wrong → [Troubleshooting](troubleshooting.md)
- Coming from v0.2.x → [Migration from v0.2.x](commands.md#migration-from-v02x)
