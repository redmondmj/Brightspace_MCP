# Brightspace API Spec Notes (for implementation)

Target: USC Brightspace (`https://brightspace.usc.edu`)
Provider: D2L Valence APIs
Reference docs:
- OAuth2: https://docs.valence.desire2learn.com/basic/oauth2.html
- API calling / paging: https://docs.valence.desire2learn.com/basic/apicall.html
- Versions: https://docs.valence.desire2learn.com/basic/version.html
- Enrollments: https://docs.valence.desire2learn.com/res/enroll.html
- Dropbox (assignments): https://docs.valence.desire2learn.com/res/dropbox.html
- News (announcements): https://docs.valence.desire2learn.com/res/news.html
- Content (modules/topics/TOC): https://docs.valence.desire2learn.com/res/content.html
- Course files (managefiles): https://docs.valence.desire2learn.com/res/course.html
- Routing table: https://docs.valence.desire2learn.com/http-routingtable.html

## Auth

- OAuth2 auth endpoint: `https://auth.brightspace.com/oauth2/auth`
- OAuth2 token endpoint: `https://auth.brightspace.com/core/connect/token`
- API calls use `Authorization: Bearer <token>`.
- Prefer env support for:
  - static access token (`BRIGHTSPACE_ACCESS_TOKEN`) OR
  - OAuth2 refresh workflow (`BRIGHTSPACE_CLIENT_ID`, `BRIGHTSPACE_CLIENT_SECRET`, `BRIGHTSPACE_REFRESH_TOKEN`, optional `BRIGHTSPACE_AUTH_HOST` default `https://auth.brightspace.com`).

## API versions

Use configurable versions because LP and LE have separate contracts.
Suggested defaults:
- `BRIGHTSPACE_LP_VERSION=1.49`
- `BRIGHTSPACE_LE_VERSION=1.82`

## Pagination patterns

From docs:
- `Api.PagedResultSet`: `{ PagingInfo: { Bookmark, HasMoreItems }, Items: [...] }`.
- `Api.ObjectListPage`: `{ Next, Objects: [...] }`.

Implement both helpers in client.

## Endpoint mapping to Canvas-like tools

### Courses
- Route: `GET /d2l/api/lp/(version)/enrollments/myenrollments/`
- Scope: `enrollment:own_enrollment:read`
- Returns `PagedResultSet<MyOrgUnitInfo>`
- Use `MyOrgUnitInfo.OrgUnit` fields:
  - `Id`, `Name`, `Code`, `Type`, `HomeUrl`
- Suggested filters:
  - keep records with `Access.CanAccess === true`
  - optional active filter via query `isActive=true`

### Assignments (Dropbox folders)
- List route: `GET /d2l/api/le/(version)/(orgUnitId)/dropbox/folders/`
- Get route: `GET /d2l/api/le/(version)/(orgUnitId)/dropbox/folders/(folderId)`
- Scope: `dropbox:folders:read`
- Relevant fields from `DropboxFolder`:
  - `Id`, `Name`, `DueDate`, `Availability.StartDate`, `Availability.EndDate`, `NotificationEmail`, `GradeItemId`

### Announcements (News)
- List route: `GET /d2l/api/le/(version)/(orgUnitId)/news/`
- Optional query: `since`
- Scope: `news:newsitems:read`
- News item fields:
  - `Id`, `Title`, `Body`, `StartDate`, `EndDate`, `CreatedDate`, `LastModifiedDate`, `IsPublished`, `IsPinned`

### Course materials
- TOC route: `GET /d2l/api/le/(version)/(orgUnitId)/content/toc`
- Scope: `content:toc:read`
- TOC has nested Modules and Topics.
- Module fields: `ModuleId`, `Title`, `StartDateTime`, `EndDateTime`, `Modules[]`, `Topics[]`
- Topic fields: `TopicId`, `Title`, `Url`, `TypeIdentifier`, `StartDateTime`, `EndDateTime`, `IsHidden`, `IsLocked`, `IsBroken`, `ActivityType`

Optional secondary route:
- `GET /d2l/api/le/(version)/(orgUnitId)/content/root/`
- Scope: `content:modules:readonly`

### Course files
- List route: `GET /d2l/api/lp/(version)/(orgUnitId)/managefiles/` with optional `path`
- Download route: `GET /d2l/api/lp/(version)/(orgUnitId)/managefiles/file?path=...`
- Scopes:
  - list: `managefiles:files:read` + `managefiles:folders:read`
  - file fetch: `managefiles:files:read`
- List returns `ObjectListPage<FileSystemObject>` where object includes:
  - `Name`
  - `FileSystemObjectType` (`1=Folder`, `2=File`)

## Implementation goals

1. Rename project to Brightspace MCP (package + docs + env vars + prompts text).
2. Keep MCP server behavior (HTTP/SSE auth, rate limiting, session cleanup).
3. Implement Brightspace client with retries/timeouts and both pagination styles.
4. Keep the high-value tool set and schema shape close to Canvas MCP:
   - `list_courses`
   - `list_assignments`
   - `get_assignment`
   - `list_announcements`
   - `list_upcoming`
   - `list_course_materials`
   - `list_course_files`
   - `list_course_folders`
   - `get_file_download_url` (path-based for Brightspace)
5. Add/update tests for:
   - auth header behavior
   - paged result set pagination
   - object list page pagination
   - mapper sanity for courses/assignments/announcements/materials
6. Ensure `npm test` and `npm run build` pass.
7. Commit and push to `origin/main` (origin points to `XiyaoWang0519/Brightspace_MCP`).

## Notes

- It is okay to simplify unsupported Canvas-only behavior (e.g., Canvas-specific external tool launch logic), but remove dead Canvas-specific code cleanly.
- Keep structured output schemas strict and useful to downstream MCP consumers.
- Prefer robust null-safe mapping because Brightspace fields can be optional/null.
