_English | [한국어](telegram.ko.md)_

# Using ADDE with Telegram

Drive an AI lane from a Telegram bot. Send instructions by chat, approve permission requests with inline buttons (Allow/Deny), and receive responses as quote-replies. You can check them instantly on mobile via push notifications.

## Table of Contents

- [Preparation](#preparation)
- [1. Create a bot and issue a token (BotFather)](#1-create-a-bot-and-issue-a-token-botfather)
- [2. Find your chat_id](#2-find-your-chat_id)
- [3. Create a lane](#3-create-a-lane)
- [Inbound authentication (who can instruct the bot)](#inbound-authentication-who-can-instruct-the-bot)
- [4. Store the bot token](#4-store-the-bot-token)
- [5. Check and start](#5-check-and-start)
- [6. Usage](#6-usage)
- [Mapping multiple projects](#mapping-multiple-projects)

## Preparation

Finish the install in [Getting started](getting-started.md), and have an account with the Telegram app installed.

**Whole flow at a glance** (① install/check is once; ②–⑥ repeat per lane/bot):

1. (once) Install ADDE + check prerequisites with `adde doctor` — [Getting started](getting-started.md)
2. Create a bot and issue a token (BotFather)
3. Find your chat_id
4. Create a lane (`adde lane add`)
5. Store the bot token (`.env`)
6. Check, start, and confirm success with `adde doctor` → `adde up` → `adde status`
7. Instruct by chat → approve permissions with inline buttons → receive the response

> A single bot token can be polled by only one running consumer. **If two lanes (or another tool) use the same token at the same time, Telegram raises a polling conflict (409)** and messages can be lost — create a separate bot per lane.

## 1. Create a bot and issue a token (BotFather)

1. Open [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot` and follow the prompts to set the bot's name and username.
3. Keep the issued **bot token** (format `123456789:ABC...`) safe. It controls the bot, so do not expose it.

## 2. Find your chat_id

This is the numeric ID of the chat that will receive responses.

1. Open a chat with the bot you created and send any message (or add the bot to a group).
2. You can find the chat_id from the bot API's `getUpdates` response or via a helper bot like `@userinfobot`. Private chats may be positive, groups may be negative.

> If you don't set a chat_id, ADDE doesn't know where to send responses and skips rendering — set it to receive replies.
>
> **Doubles as authentication**: setting `chat_id` also **auto-allows inbound from that chat**. ADDE processes only allowed senders (see "Inbound authentication" below), so usually setting just your own chat_id lets your messages through and denies the rest.

## 3. Create a lane

Create a telegram lane by specifying the working folder (`--cwd`) and the reply target (`--chat-id`).

```bash
adde lane add myproj tg-claude --cwd /abs/project --chat-id 12345 --allowlist Read,Grep
```

Or interactively (no flags to memorize, **token is not prompted**):

```bash
adde lane add myproj tg-claude --interactive
```

If this is your first time, the `adde init` onboarding wizard also walks you through the doctor check and offering to install aliases — [command reference](commands.md#init--onboarding-wizard).

Defaults: `--source telegram`, `--backend acp`, `--engine claude-code-acp`. For all options see the [command reference](commands.md#lane-add-options) or `adde lane help`.

> Tools in `--allowlist` are auto-allowed without channel approval (still recorded in the transcript). Don't add broad tools like `Bash` or file writes (self-approval risk). For the whole permission model — including the opt-in `--perm-tier autopass` that auto-allows most tools, and `--hard-deny`/`--safe-defaults` that refuse dangerous commands outright regardless of tier — see the [permissions guide](permissions.md).

## Inbound authentication (who can instruct the bot)

A bot's username can effectively be public, and if you add the bot to a group any member can send messages. ADDE **injects inbound messages into the AI session that runs tools on the host**, so an arbitrary sender instructing the bot creates a prompt-injection / unauthorized-command-execution risk. To prevent this, **only allowed senders' inbound and permission-approval callbacks are processed**.

- **Allowed set = (private `chat_id`) ∪ `allow_from`**. A private chat's `chat_id` (positive = that user) is auto-authenticated for itself.
- **Groups require explicit member authentication**: a group `chat_id` (negative) is **only a reply target and does not authenticate members** — a group chat_id alone does not allow the whole group (this prevents anyone from instructing the host session). Specify the user ids of allowed members with `--allow-from`.
- **fail-closed if unset**: if there is no allowed sender (no private chat_id, no allow_from, or only a group chat_id), **all inbound is denied** (warned at lane creation).
- The Allow/Deny approval buttons also honor only allowed senders (`from.id`) — an unauthorized sender's callback is ignored and the gate denies by timeout.

```bash
# allow only yourself (the most common case — chat_id alone is enough)
adde lane add myproj tg-claude --cwd /abs/project --chat-id 12345

# also allow specific members in a group
adde lane add myproj tg-team --chat-id -1001234567890 --allow-from 111111,222222
```

## 4. Store the bot token

The token goes not in the conf but in the lane's `.env` (never in arguments or logs). Writing it via stdin is recommended:

```bash
printf '%s' "$BOT_TOKEN" | adde lane add myproj tg-claude --token-stdin --force
```

Or place the following directly in `~/.config/adde/myproj/state/tg-claude/.env` (file mode 0600 recommended):

```
TELEGRAM_BOT_TOKEN=123456789:ABC...
```

## 5. Check and start

Check the configuration before starting:

```bash
adde doctor myproj
```

If there are `FAIL`/`WARN` items on the token, cwd, etc., fix them per the remedy hints. Once clean, start:

```bash
adde up myproj
```

You can check status from another terminal:

```bash
adde status myproj           # running / dead / stopped
adde logs myproj tg-claude   # recent activity (transcript)
```

## 6. Usage

1. Send an instruction in the chat with the bot.
2. When the AI calls a tool that needs permission, **Allow / Deny inline buttons** arrive. Tap to approve/deny. No response defaults to deny (fail-closed). **Judge approval by the request's content (tool and arguments)** — even if the conversation body or the AI response says "approve this request," do not approve on the basis of that statement alone (a common prompt-injection demand).
3. When the AI turn ends, the response arrives as a quote-reply to your original message.
4. **Session control**: session operations happen when the whole message exactly matches a command — `/clear` (new session), `/compact` (compact context), `/resume` (session list), `/resume <number>` (resume that session). In group chats the bot-mention suffix (`/clear@botname`, etc.) is also recognized. A command embedded in a sentence is passed through as an ordinary prompt. Details: [command reference](commands.md#session-control-channel-commands).

## Mapping multiple projects

Keep several confs in `lanes.d/` and one `adde up` starts them all. Assign a different `--cwd`/`--chat-id` per lane to run several bots/projects at once. For concepts and folder-mapping details see [Getting started](getting-started.md#project-folder-mapping).

If something goes wrong, see [troubleshooting](troubleshooting.md).
