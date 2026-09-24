# @hallaxius/skills

[![CI](https://github.com/Hallaxius/skills/actions/workflows/ci.yml/badge.svg)](https://github.com/Hallaxius/skills/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-stdio-blue.svg)](https://modelcontextprotocol.io)

An unofficial [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that exposes [skills.sh](https://skills.sh) — The Agent Skills Directory — as tools for AI agents and coding assistants.

> **Not affiliated.** This is an independent community project maintained by [Hallaxius](https://github.com/hallaxius). It is NOT associated with, endorsed by, or supported by skills.sh or Vercel. All data served by this server belongs to skills.sh and its users, and is fetched live from the public site.

## Table of contents

- [Overview](#overview)
- [What you get](#what-you-get)
- [Quick start](#quick-start)
- [Requirements](#requirements)
- [Environment variables](#environment-variables)
- [Tools](#tools)
  - [search_skills](#search_skills)
  - [get_top_skills](#get_top_skills)
  - [get_skill](#get_skill)
  - [get_skill_audits](#get_skill_audits)
  - [get_official_skills](#get_official_skills)
  - [Validation caps quick reference](#validation-caps-quick-reference)
- [MCP client configuration](#mcp-client-configuration)
- [How it works](#how-it-works)
  - [Data sources](#data-sources)
  - [Skill id format](#skill-id-format)
  - [Caching](#caching)
  - [Rate limiting](#rate-limiting)
  - [Security and privacy](#security-and-privacy)
  - [Error handling](#error-handling)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Legal notes](#legal-notes)
- [License](#license)

## Overview

This server lets any MCP-capable client query skills.sh directly:

- **Discover** skills by keyword, by owner, or through the official leaderboards (all-time, trending, hot).
- **Inspect** a skill: full description, install count, topics, related skills, ready-to-use install command.
- **Vet** a skill before installing it: aggregated security audits from Socket, Snyk, Gen Agent Trust Hub, Runlayer and ZeroLeaks.
- **Browse** the official/curated directory of trusted owners (Vercel, Anthropic, Microsoft, Google, Supabase, Cloudflare, ...).
- **Install** what you find with the official [`npx skills`](https://github.com/vercel-labs/skills) CLI — every result includes the exact command to run.

Everything runs over the standard MCP stdio transport. There is no database, no backend of our own, and no telemetry: the server talks only to skills.sh.

## What you get

| Tool | Description | Token needed? |
|---|---|---|
| `search_skills` | Search the directory by keyword (fuzzy; semantic with a token) | optional |
| `get_top_skills` | Leaderboards: `all-time`, `trending`, or `hot` | no |
| `get_skill` | Full details for one skill (description, installs, topics, related, optional file contents) | only for `include_files` |
| `get_skill_audits` | Third-party security audits for a skill | no |
| `get_official_skills` | Official/curated skills grouped by owner | no |

All five tools are read-only, return a single pretty-printed JSON text block, and report failures as MCP tool errors with a stable `[CODE] message` prefix.

## Quick start

Run the published package directly — nothing to install:

```bash
npx -y @hallaxius/skills
# or, with Bun:
bunx @hallaxius/skills
```

The server starts on stdio and waits for an MCP client. Point your client's MCP config at the command above (see [MCP client configuration](#mcp-client-configuration)), then ask your agent things like *"find a skill for React performance auditing on skills.sh"*.

## Requirements

- Node.js 18 or newer (for `npx`), or [Bun](https://bun.sh)
- An MCP-capable client (Claude Desktop, Claude Code, Cursor, OpenCode, ...)
- Internet access to `skills.sh`

That's all — the server has no other dependencies or services.

## Environment variables

All optional — the server is fully functional with none of them set. Add them as an `env` block in your MCP client config (see [Variants](#variants) below).

| Variable | Default | Allowed range | Description |
|---|---|---|---|
| `VERCEL_OIDC_TOKEN` | none | — | Vercel OIDC token for the [documented skills.sh v1 API](https://skills.sh/docs/api). Enables semantic (multi-word) search via `search_skills` and skill file contents via `get_skill` (`include_files: true`). To obtain one: install the Vercel CLI (`npm i -g vercel`), enable OIDC Federation for any project (dashboard → Settings → Security → Secure backend access), then run `vercel link` followed by `vercel env pull` (writes it to `.env.local`, valid for roughly 12 hours — re-pull to refresh, and never commit that file). If the token expires, search automatically falls back to the public endpoint. |
| `SKILLS_MIN_INTERVAL_MS` | `500` | 0–60000 | Minimum gap between consecutive requests to skills.sh. Raise it if you hit `RATE_LIMITED`. |
| `SKILLS_TIMEOUT_MS` | `10000` | 1000–60000 | Timeout per request. Raise it on slow networks. |

Without a token the server still works fully: it uses the public search endpoint that the official `npx skills` CLI itself uses, the public audit API, and the same leaderboard/official/skill pages you see in the browser.

## Tools

Examples below are abridged from real live calls — install counts and leaderboards change over time.

### search_skills

Search skills.sh for skills matching a query.

**Arguments**

| Parameter | Type | Constraints | Default |
|---|---|---|---|
| `query` | string | 2–100 characters after trimming | required |
| `limit` | integer | 1–50 | 20 |
| `owner` | string | GitHub-style owner/organization name (letters, digits, hyphens; max 39 chars) | — |

**Example call**

```json
{
  "query": "react",
  "limit": 3
}
```

**Example response** (public mode, abridged — the response is a JSON *array*)

```json
[
  {
    "id": "vercel-labs/json-render/react",
    "source": "vercel-labs/json-render",
    "skillId": "react",
    "name": "react",
    "installs": 11446,
    "installCommand": "npx skills add https://github.com/vercel-labs/json-render --skill react"
  },
  {
    "id": "lobehub/lobehub/react",
    "source": "lobehub/lobehub",
    "skillId": "react",
    "name": "react",
    "installs": 5516,
    "installCommand": "npx skills add https://github.com/lobehub/lobehub --skill react"
  }
]
```

**Response fields**

| Field | Type | Notes |
|---|---|---|
| `id` | string | Canonical id `{source}/{skillId}` — feed it to `get_skill` / `get_skill_audits` |
| `source` | string | GitHub `owner/repo` or well-known domain |
| `skillId` | string | Skill slug within the source |
| `name` | string | Display name |
| `installs` | number | Deduplicated install count |
| `installCommand` | string? | Derived `npx skills add ...` command (GitHub-hosted skills only in public mode) |
| `sourceType` | string? | v1 mode only: `github` or `well-known` |
| `installUrl` | string? | v1 mode only |
| `url` | string? | v1 mode only: canonical skills.sh page |
| `isDuplicate` | boolean? | v1 mode only: fork/copy flag |

Notes:

- Without a token: fuzzy search via the public endpoint (the same one the official CLI uses), no descriptions in results (the endpoint does not return them).
- With `VERCEL_OIDC_TOKEN`: searches go through the documented v1 API, which adds semantic multi-word ranking and the v1-only fields above. If the token is rejected (expired), the server logs a warning to stderr and transparently falls back to the public endpoint.

### get_top_skills

Read a skills.sh leaderboard. Each leaderboard page embeds up to 600 entries; use `offset` to page through them.

**Arguments**

| Parameter | Type | Constraints | Default |
|---|---|---|---|
| `view` | enum | `all-time`, `trending`, or `hot` | `all-time` |
| `limit` | integer | 1–50 | 20 |
| `offset` | integer | 0–290 | 0 |

**Example call**

```json
{
  "view": "hot",
  "limit": 3
}
```

**Example response** (abridged)

```json
{
  "view": "hot",
  "offset": 0,
  "count": 3,
  "totalAvailable": 600,
  "skills": [
    {
      "id": "uizze.sh/ui-taste",
      "source": "uizze.sh",
      "skillId": "ui-taste",
      "name": "ui-taste",
      "installs": 762,
      "installsYesterday": 222,
      "change": 540
    }
  ]
}
```

**Response fields**

| Field | Type | Notes |
|---|---|---|
| `view` | enum | Echo of the requested view |
| `offset` | number | Echo of the requested offset |
| `count` | number | Entries in this slice |
| `totalAvailable` | number | Entries embedded in the page (600 observed) |
| `skills[].id` / `source` / `skillId` / `name` / `installs` | — | Same identity fields as `search_skills` |
| `skills[].installCommand` | string? | Present for GitHub-hosted skills |
| `skills[].weeklyInstalls` | number[]? | `all-time` view only: 8 trailing values (presumed daily install counts, passed through as-is) |
| `skills[].isOfficial` | boolean? | `all-time` view only: official publisher flag |
| `skills[].installsYesterday` | number? | `hot` view only: installs during the last day |
| `skills[].change` | number? | `hot` view only: change vs. yesterday |

### get_skill

Full details for a single skill.

**Arguments**

| Parameter | Type | Constraints | Default |
|---|---|---|---|
| `id` | string | 3–200 chars; `{owner}/{repo}/{skill}` or `{domain}/{skill}` (see [Skill id format](#skill-id-format)) | required |
| `include_files` | boolean | requires `VERCEL_OIDC_TOKEN` | false |

**Example call**

```json
{
  "id": "vercel-labs/skills/find-skills"
}
```

**Example response** (abridged from a live call)

```json
{
  "id": "vercel-labs/skills/find-skills",
  "source": "vercel-labs/skills",
  "slug": "find-skills",
  "name": "find-skills",
  "description": "Helps users discover and install agent skills when they ask questions like \"how do I do X\", \"find a skill for X\" ...",
  "owner": "vercel-labs",
  "installs": 3539262,
  "url": "https://www.skills.sh/vercel-labs/skills/find-skills",
  "installCommand": "npx skills add https://github.com/vercel-labs/skills --skill find-skills",
  "topics": ["agents"],
  "related": [
    {
      "id": "anthropics/skills/frontend-design",
      "name": "frontend-design",
      "description": "..."
    }
  ]
}
```

**Response fields**

| Field | Type | Notes |
|---|---|---|
| `id` / `source` / `slug` | string | Canonical identity |
| `name` | string | Skill name |
| `description` | string | Full, untruncated description |
| `owner` | string | Publisher (GitHub owner or domain) |
| `installs` | number | Install count |
| `url` | string | Canonical skills.sh page URL |
| `installCommand` | string or null | Ready-to-run install command; null when unavailable |
| `topics` | string[] | Topics of this skill |
| `related` | `{id, name, description}[]` | Related skills (up to 20) |
| `files` | array or null? | Only with `include_files: true` plus a token: `{path, contents}[]` (e.g. the raw `SKILL.md`) |
| `hash` | string or null? | Content hash (v1 API) |
| `filesNote` | string? | Present when the API reports no published file bundle for the skill |

Calling `include_files: true` without a token returns `[INVALID_INPUT]` with instructions on how to enable it (metadata above is still available without a token).

### get_skill_audits

Security audits recorded for a skill. Audits are produced by third parties after a skill's first install; a skill that was never installed/audited returns `NOT_FOUND` with a message explaining that.

**Arguments**

| Parameter | Type | Constraints | Default |
|---|---|---|---|
| `id` | string | 3–200 chars; same format as `get_skill` | required |

**Example call**

```json
{
  "id": "vercel-labs/skills/find-skills"
}
```

**Example response** (abridged from a live call — 5 providers were returned)

```json
{
  "id": "vercel-labs/skills/find-skills",
  "source": "vercel-labs/skills",
  "slug": "find-skills",
  "audits": [
    {
      "provider": "Gen Agent Trust Hub",
      "slug": "agent-trust-hub",
      "status": "pass",
      "summary": "This skill facilitates the discovery and installation of agent extensions using a dedicated command-line interface ...",
      "auditedAt": "2026-09-15T08:00:05.922Z",
      "riskLevel": "SAFE",
      "categories": ["..."]
    }
  ]
}
```

**Response fields**

| Field | Type | Notes |
|---|---|---|
| `audits[].provider` | string | Observed: `Gen Agent Trust Hub`, `Socket`, `Snyk`, `Runlayer`, `ZeroLeaks` |
| `audits[].slug` | string | Provider slug |
| `audits[].status` | enum | `pass`, `warn`, or `fail` |
| `audits[].summary` | string | Provider's assessment text |
| `audits[].auditedAt` | string | ISO 8601 timestamp |
| `audits[].riskLevel` | string? | Risk label from the provider — observed values include `NONE`, `LOW`, `SAFE`, `MEDIUM`, `HIGH`, `CRITICAL` |
| `audits[].categories` | string[]? | Only emitted by some providers (observed on Gen Agent Trust Hub) |

This tool works **without** any token (the audit endpoint is public).

### get_official_skills

Official/curated skills grouped by owner — the same dataset as the [skills.sh /official](https://skills.sh/official) page. The real list currently has roughly 100 owners.

**Arguments**

| Parameter | Type | Constraints | Default |
|---|---|---|---|
| `limit` | integer | 1–100 (number of owners) | 20 |

**Example call**

```json
{
  "limit": 2
}
```

**Example response** (shape, abridged)

```json
{
  "count": 2,
  "owners": [
    {
      "owner": "aave",
      "totalInstalls": 10,
      "featuredRepo": "aave/skills",
      "featuredSkill": "deleverage",
      "repos": [
        {
          "repo": "aave/skills",
          "totalInstalls": 10,
          "skills": [
            { "name": "deleverage", "installs": 2 }
          ]
        }
      ]
    }
  ]
}
```

**Response fields**

| Field | Type | Notes |
|---|---|---|
| `count` | number | Owners in this slice |
| `owners[].owner` | string | GitHub owner |
| `owners[].totalInstalls` | number | Aggregate installs for the owner |
| `owners[].featuredRepo` / `featuredSkill` | string | Highlighted repo and skill |
| `owners[].repos[].repo` | string | `owner/repo` |
| `owners[].repos[].totalInstalls` | number | Aggregate for the repo |
| `owners[].repos[].skills[]` | `{name, installs}[]` | Skills in the repo |

### Validation caps quick reference

| Input | Rule |
|---|---|
| `query` | 2–100 chars (after trimming) |
| `limit` (search, top) | integer 1–50 |
| `offset` | integer 0–290 |
| `limit` (official) | integer 1–100 |
| `view` | exactly `all-time`, `trending`, or `hot` |
| `owner` | `^[a-z0-9](?:[a-z0-9-]{0,38})$/i` |
| `id` | 3–200 chars total; 2 or 3 `/`-separated segments, each 2–100 chars (letters, digits, `.`, `_`, `-`), no `..` |

Violations are rejected before any network activity and surface as tool errors whose text starts with `Input validation error`.

## MCP client configuration

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "skills-sh": {
      "command": "npx",
      "args": ["-y", "@hallaxius/skills"]
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "skills-sh": {
      "command": "npx",
      "args": ["-y", "@hallaxius/skills"]
    }
  }
}
```

**OpenCode** (`opencode.json` in the project, or `~/.config/opencode/opencode.json` globally):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "skills-sh": {
        "type": "local",
        "command": ["npx", "-y", "@hallaxius/skills"],
        "disabled": false
      }
    }
  }
}
```

**Claude Code (CLI)**:

```bash
claude mcp add skills-sh -- npx -y @hallaxius/skills
```

**Any other MCP client** that supports local stdio servers: use the standard `mcpServers` shape from the Claude Desktop example above.

### Variants

- Prefer Bun? Replace `npx -y` with `bunx` (`["bunx", "@hallaxius/skills"]`).
- Need the token or tuning knobs? Add an `env` block to the server entry, for example:

```json
{
  "mcpServers": {
    "skills-sh": {
      "command": "npx",
      "args": ["-y", "@hallaxius/skills"],
      "env": {
        "VERCEL_OIDC_TOKEN": "your-token-here",
        "SKILLS_MIN_INTERVAL_MS": "500"
      }
    }
  }
}
```

Avoid pasting the token into the file when the client supports environment substitution (OpenCode: `"VERCEL_OIDC_TOKEN": "{env:VERCEL_OIDC_TOKEN}"`).

## How it works

### Data sources

The server uses only sources that skills.sh itself sanctions for programmatic use:

1. **Public search API** — `GET https://skills.sh/api/search` (unauthenticated). The same endpoint used by the official `npx skills` CLI (`skills find`).
2. **Documented v1 API** — `https://skills.sh/api/v1/*` per [skills.sh/docs/api](https://skills.sh/docs/api). Search and skill files require `VERCEL_OIDC_TOKEN` (Bearer auth); the audit endpoint works unauthenticated. With a token configured, `search_skills` upgrades to v1 search (fuzzy/semantic).
3. **Public site pages** — `/`, `/trending`, `/hot`, `/official`, and skill pages, read from their embedded structured data (never visual scraping of markup).

Which tool uses what:

| Tool | Without token | With `VERCEL_OIDC_TOKEN` |
|---|---|---|
| `search_skills` | public `/api/search` (fuzzy) | v1 search (semantic capable; falls back to public on auth errors) |
| `get_top_skills` | site leaderboards | same |
| `get_skill` | skill page | same, plus v1 API for `include_files` |
| `get_skill_audits` | v1 audit endpoint (public) | same |
| `get_official_skills` | site `/official` page | same |

A token therefore only unlocks two things: semantic search and file contents.

### Skill id format

Every id is `{source}/{slug}`:

| Form | Example |
|---|---|
| GitHub: `{owner}/{repo}/{skill}` | `vercel-labs/skills/find-skills` |
| Well-known: `{domain}/{skill}` | `uizze.sh/ui-taste` |

Ids are strictly validated and request URLs are assembled **only** from validated segments — the server never accepts a user-supplied URL, so every outbound request stays on skills.sh.

### Caching

Results are cached in memory:

| Data | Fresh for |
|---|---|
| Search results | 30 s |
| Leaderboards | 60 s |
| Skill details, files, audits, official list | 300 s |

### Rate limiting

Requests to skills.sh are deliberately paced:

- Serialized with a minimum gap (default 500 ms), so concurrent calls don't burst the site.
- Timeout per request (default 10 s) with up to 2 automatic retries on transient failures.
- `429` responses are honored via `Retry-After`; if the limit persists you get `[RATE_LIMITED]` — just wait a moment and retry.

The first call after idle time takes around half a second; cached repeats need no request.

### Security and privacy

- **No telemetry.** No analytics, no phone-home, no third-party endpoints. The only network traffic is GET requests to `skills.sh` / `www.skills.sh`.
- **Token handling.** `VERCEL_OIDC_TOKEN` is sent only as a `Bearer` header to the skills.sh v1 API, never logged, and never sent anywhere else. Expiry degrades gracefully (search falls back to the public endpoint).
- **No SSRF.** No tool accepts a URL; all request targets are assembled from validated id segments on fixed `skills.sh` hosts.
- **Protocol hygiene.** stdout carries only MCP JSON-RPC; every log line goes to stderr.

### Error handling

Tool failures are returned as MCP tool errors (`isError: true`) with a stable `[CODE] message` prefix:

| Code | Meaning | What to do |
|---|---|---|
| `NETWORK_ERROR` | request failed at the network level | check your connection and retry |
| `TIMEOUT` | request took too long | retry; raise `SKILLS_TIMEOUT_MS` on slow networks |
| `RATE_LIMITED` | skills.sh rate limit persisted | wait a moment and retry; raise `SKILLS_MIN_INTERVAL_MS` |
| `NOT_FOUND` | skill/page does not exist, or no audits yet | verify the id; audits appear after a skill's first install |
| `INVALID_INPUT` | bad arguments (malformed id, `include_files` without token) | see [Validation caps](#validation-caps-quick-reference) and [Environment variables](#environment-variables) |
| `PARSE_ERROR` | upstream returned invalid JSON | transient — retry |
| `UPSTREAM_CHANGED` | skills.sh changed its data structure | upgrade the package |
| `UPSTREAM_ERROR` | upstream 5xx or auth failure | retry; if it mentions the token, refresh it |

Example error result:

```json
{
  "content": [
    {
      "type": "text",
      "text": "[NOT_FOUND] no security audits recorded for \"vercel-labs/skills/find-skills\" yet — audits are generated automatically after a skill's first install"
    }
  ],
  "isError": true
}
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `[INVALID_INPUT] invalid skill id ...` | id does not match the two accepted forms | use `owner/repo/skill` or `domain/skill` (see [Skill id format](#skill-id-format)) |
| `[INVALID_INPUT] include_files requires the documented v1 API ...` | `include_files: true` without a token | set `VERCEL_OIDC_TOKEN` (see [Environment variables](#environment-variables)), or drop `include_files` |
| Error text starts with `Input validation error` | argument outside the caps | check [Validation caps quick reference](#validation-caps-quick-reference) |
| `[NOT_FOUND] ... audits are generated automatically ...` | skill has never been installed/audited | expected; pick another skill or install it first |
| `[NOT_FOUND] skill ... not found` | wrong id or removed skill | verify the id on skills.sh |
| `[RATE_LIMITED] skills.sh is rate limiting us ...` | upstream rate limit persisted | wait a moment and retry; raise `SKILLS_MIN_INTERVAL_MS` |
| `[UPSTREAM_ERROR] ... check VERCEL_OIDC_TOKEN` | expired/invalid token on v1 calls | refresh the token (`vercel link` + `vercel env pull`); search keeps working via the public fallback |
| `[UPSTREAM_CHANGED] ...` | skills.sh changed its data structure | upgrade the package |
| `[TIMEOUT]` / `[NETWORK_ERROR]` | connectivity or slow upstream | retry; raise `SKILLS_TIMEOUT_MS` |
| `npx: command not found` | Node.js missing | install Node.js 18+ (or use `bunx`) |
| First tool call feels slow | deliberate pacing plus possible retries | expected: requests are serialized with a minimum gap |

## Limitations

- The public search endpoint is undocumented (it is the one the official CLI uses); if skills.sh changes it, no-token search may report `UPSTREAM_CHANGED` until the package is updated.
- Without a token: search is fuzzy only (no semantic multi-word ranking), search results carry no descriptions, and `get_skill` cannot return file contents.
- Leaderboard pagination is capped at what pages embed (`offset` 0–290).
- `weeklyInstalls` values are passed through as-is from the site.
- Data freshness follows the [Caching](#caching) TTLs; install counts change continuously on skills.sh itself.

## Legal notes

- This project respects `robots.txt`: only generally-allowed pages (`/`, `/trending`, `/hot`, `/official`, skill and owner pages) are retrieved.
- skills.sh's terms of use describe a public API that is rate-limited per IP and state: "Reasonable use, including caching results on your own infrastructure, is encouraged and not restricted." This server is built exactly around that contract — rate limiting, caching, an identifiable user agent, and no scraping behind authentication or anti-bot mechanisms.
- This project is unofficial and not affiliated with skills.sh or Vercel. If the operators object to any aspect of it, the right move is to take it down.

## License

[MIT](./LICENSE) © Hallaxius
