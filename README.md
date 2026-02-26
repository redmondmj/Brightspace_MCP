# Brightspace MCP Server

Local Model Context Protocol (MCP) server that exposes USC Brightspace read-only tooling over HTTP/SSE (and optional stdio) for agent integrations. The server provides authenticated access to courses, assignments, announcements, materials, and course files using the D2L Valence APIs, with pagination, retries, and structured JSON responses.

**Key features**
- Brightspace client with retries, timeouts, and both Valence pagination styles.
- HTTP/SSE transport with bearer auth, rate limiting, and session cleanup.
- JSON console logging with request metadata and Brightspace status codes.
- Consistent MCP error mapping for Brightspace 401/403/404/429/5xx responses.
- Pre-built MCP prompts for common Brightspace workflows (quickstart, assignment planning, announcements, file access).

## Quick start

1. Install dependencies:

```bash
npm install
```

2. Populate `.env` with Brightspace credentials and `MCP_BEARER`:

```bash
cp .env.example .env
```

3. Start the server:

```bash
npm run build
node dist/index.js
```

Optional stdio transport:

```bash
node dist/index.js --stdio
```

## Environment variables

Required:
- `BRIGHTSPACE_BASE_URL`
- `MCP_BEARER`
- Either `BRIGHTSPACE_ACCESS_TOKEN` OR the OAuth refresh trio (`BRIGHTSPACE_CLIENT_ID`, `BRIGHTSPACE_CLIENT_SECRET`, `BRIGHTSPACE_REFRESH_TOKEN`)

Optional Brightspace:
- `BRIGHTSPACE_AUTH_HOST` (default `https://auth.brightspace.com`)
- `BRIGHTSPACE_LP_VERSION` (default `1.49`)
- `BRIGHTSPACE_LE_VERSION` (default `1.82`)
- `BRIGHTSPACE_TIMEZONE` (default `UTC`)
- `BRIGHTSPACE_HTTP_TIMEOUT_MS` (default `15000`, min `1000`, max `120000`)

Optional MCP server:
- `MCP_RATE_LIMIT_WINDOW_MS`, `MCP_RATE_LIMIT_MAX`
- `MCP_MESSAGES_RATE_LIMIT_WINDOW_MS`, `MCP_MESSAGES_RATE_LIMIT_MAX`
- `MCP_SESSION_TTL_MS`, `MCP_SESSION_CLEANUP_INTERVAL_MS`, `MCP_MAX_SESSIONS`, `MCP_SSE_HEARTBEAT_MS`

## Tools

Tool names and payloads are kept as close as practical to the original Canvas MCP schema, while mapped to Brightspace endpoints.

- `list_courses` → Brightspace enrollments
- `list_assignments` → Dropbox folders
- `get_assignment` → Dropbox folder by id
- `list_announcements` → News items
- `list_upcoming` → Aggregated upcoming assignments across courses
- `list_course_materials` → Content table of contents (modules/topics)
- `list_course_files` → Course file listing by path
- `list_course_folders` → Course folder listing by path
- `get_file_download_url` → Direct file download URL by path

### Example responses

Assignments:

```json
{
  "assignments": [
    {
      "id": 42,
      "course_id": 12345,
      "name": "Project 1",
      "due_at": "2025-10-05T23:59:00Z",
      "points": null,
      "html_url": "",
      "submission_state": "unsubmitted"
    }
  ]
}
```

Files:

```json
{
  "files": [
    {
      "id": 918273,
      "display_name": "Syllabus.pdf",
      "filename": "Syllabus.pdf",
      "path": "/Syllabus.pdf"
    }
  ]
}
```

Download URL:

```json
{
  "file_id": 918273,
  "download_url": "https://brightspace.usc.edu/d2l/api/lp/1.49/12345/managefiles/file?path=%2FSyllabus.pdf",
  "path": "/Syllabus.pdf"
}
```

## Prompts

| Prompt | Args | Description |
| --- | --- | --- |
| `brightspace.quickstart` | _(none)_ | Kick-off instructions that remind the model how to explore Brightspace data safely with the available tools. |
| `brightspace.assignment_brief` | `course_hint?: string`, `days?: string (digits)` | Guides the model through gathering assignments and upcoming items for a specific course and time horizon. |
| `brightspace.announcement_digest` | `course_hint?: string`, `since?: string (ISO-8601)` | Helps the model compile a digest of recent announcements. |
| `brightspace.file_access` | `course_hint?: string`, `file_type?: string` | Guides the model through locating and accessing Brightspace files. |

## Logging and errors

Logs are JSON documents written to stdout/stderr with fields: `tool`, `status`, `duration_ms`, `brightspace_status`, `req_id`, and optional `extra_req_ids` & `error` summaries. Secrets are never logged.

Brightspace errors map to MCP errors with user-facing messages:

| Brightspace status | Message |
| --- | --- |
| 401/403 | `Authorization failed: check Brightspace token/scopes.` |
| 429 | `Rate limited by Brightspace; retry later.` |
| 5xx | `Brightspace temporarily unavailable.` (surfaced as HTTP 503 to the client) |

Each error includes `request_id` (Brightspace `X-Request-Id`) and the last Brightspace status code in MCP error `data`.

## Development

```bash
npm test
npm run build
```
