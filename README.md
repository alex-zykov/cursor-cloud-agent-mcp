# Cloud Agent MCP Server

MCP server for the [Cursor Cloud Agents API v1](https://cursor.com/docs/cloud-agent/api/endpoints). Lets AI assistants create and manage cloud agents that work on GitHub repositories.

> **v2 / API v1:** Work is split into a durable **agent** plus per-prompt **runs** (replacing the flatter v0 “task” surface). Legacy tool names (`create_task`, `list_tasks`, …) remain as aliases.

## Quick Start

```bash
# Install
npm install -g cursor-cloud-agent-mcp

# Set your API key
export CURSOR_API_KEY=your_api_key_here

# Use with Cursor (create .cursor/mcp.json)
{
  "mcpServers": {
    "cursor-cloud-agent": {
      "command": "npx",
      "args": ["-y", "cursor-cloud-agent-mcp"],
      "env": {
        "CURSOR_API_KEY": "${env:CURSOR_API_KEY}"
      }
    }
  }
}
```

## Installation

### Install from npm

```bash
npm install -g cursor-cloud-agent-mcp
```

Or install locally in your project:

```bash
npm install cursor-cloud-agent-mcp
```

### Install from Source

```bash
git clone https://github.com/jxnl/cursor-cloud-agent-mcp
cd cursor-cloud-agent-mcp
npm install

export CURSOR_API_KEY=your_api_key_here

npm start          # HTTP → http://localhost:3000/mcp
npm run start:stdio
```

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `CURSOR_API_KEY` | Yes | API key from [Cursor Dashboard → API Keys](https://cursor.com/dashboard) |
| `PORT` | No | HTTP server port (default: 3000) |

Auth uses HTTP Basic with the API key as username (empty password), same as the official API docs. Bearer auth is also accepted by the API.

## Usage

### Typical Workflow (API v1)

```text
1. get_repos       → Get current repo URL and branch
2. create_agent    → Launch agent + initial run → { agent, run }
3. get_agent       → Agent ACTIVE|IDLE + latest run CREATING|RUNNING|FINISHED|…
4. create_run      → Follow-up prompt when agent is IDLE
5. list_runs / get_run → Inspect run results, branches, PR URLs
6. archive_agent   → Soft-delete (or delete_agent for permanent)
```

### Available Tools

#### Discovery

| Tool | Description |
|------|-------------|
| `get_repos` | Current git repo + optional `GET /v1/repositories` (rate limited; filters required for `include_all`) |
| `get_me` | `GET /v1/me` — verify API key |
| `get_models` | `GET /v1/models` — model ids + params/variants |

#### Agent lifecycle

| Tool | API | Description |
|------|-----|-------------|
| `create_agent` | `POST /v1/agents` | Create agent + enqueue initial run |
| `list_agents` | `GET /v1/agents` | List agents (lean items) |
| `get_agent` | `GET /v1/agents/{id}` + latest run | Agent metadata + latest run |
| `create_run` | `POST /v1/agents/{id}/runs` | Follow-up prompt |
| `list_runs` | `GET /v1/agents/{id}/runs` | List runs |
| `get_run` | `GET /v1/agents/{id}/runs/{runId}` | Run status / result / git |
| `cancel_run` | `POST .../runs/{runId}/cancel` | Cancel active run |
| `get_conversation` | composed from runs | Run results (no v1 `/conversation` endpoint) |
| `archive_agent` | `POST /v1/agents/{id}/archive` | Soft delete |
| `unarchive_agent` | `POST /v1/agents/{id}/unarchive` | Restore |
| `delete_agent` | `DELETE /v1/agents/{id}` | Permanent delete |

**Aliases (v0-style names):** `create_task`, `list_tasks`, `get_task`, `add_followup`, `delete_task`.

### Status values

- **Agent:** `ACTIVE` | `IDLE` | `ARCHIVED`
- **Run:** `CREATING` | `RUNNING` | `FINISHED` | `ERROR` | `CANCELLED` | `EXPIRED`

### Examples

#### Create an agent

```json
{
  "tool": "create_agent",
  "arguments": {
    "prompt": "Add a README.md file with installation instructions",
    "repository": "https://github.com/your-org/your-repo",
    "auto_pr": true
  }
}
```

Response shape (v1):

```json
{
  "agent": {
    "id": "bc-...",
    "name": "Add README with setup instructions",
    "status": "ACTIVE",
    "url": "https://cursor.com/agents/bc-...",
    "latestRunId": "run-...",
    "createdAt": "..."
  },
  "run": {
    "id": "run-...",
    "agentId": "bc-...",
    "status": "CREATING",
    "createdAt": "..."
  }
}
```

#### Follow-up run

```json
{
  "tool": "create_run",
  "arguments": {
    "id": "bc-...",
    "prompt": "Also add a troubleshooting section"
  }
}
```

#### List agents

```json
{
  "tool": "list_agents",
  "arguments": {
    "filter": "ACTIVE|IDLE",
    "limit": 10
  }
}
```

## Migrating from v0 / package 1.x

| Old (v0) | New (v1) |
|----------|----------|
| `POST /v0/agents` with `source` / `target` | `POST /v1/agents` with `repos[]`, `autoCreatePR` |
| Flat agent status `CREATING`/`RUNNING`/`FINISHED` | Agent lifecycle + **run** status |
| `POST .../followup` | `POST .../runs` |
| `GET .../conversation` | No v1 equivalent — use `list_runs` / `get_run` / `get_conversation` (run results) |
| `DELETE /v0/agents/{id}` | Same path under `/v1/`; prefer `archive_agent` |
| `model: "string"` | `model: { "id": "string" }` |
| Custom `branchName` | Auto `cursor/...` branch, or `workOnCurrentBranch: true` |

Docs: [Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints) · [v0 legacy](https://cursor.com/docs/cloud-agent/api/v0)

## Server Versions

- **HTTP** (`npm start`): Express on port 3000
- **Stdio** (`npm run start:stdio`): recommended for local Cursor MCP

## License

MIT
