import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { BrightspaceClient, type BrightspaceResult } from '../brightspace/client.js';
import {
  BrightspaceContentToc,
  BrightspaceDropboxFolder,
  BrightspaceFileSystemObject,
  BrightspaceMyOrgUnitInfo,
  BrightspaceNewsItem
} from '../brightspace/types.js';
import { AppError, unknownError } from '../core/errors.js';
import { log, logToolEvent } from '../core/logger.js';
import {
  getAssignmentOutputSchema,
  getFileDownloadUrlOutputSchema,
  listAnnouncementsOutputSchema,
  createAnnouncementOutputSchema,
  listAssignmentsOutputSchema,
  listCourseMaterialsOutputSchema,
  listCoursesOutputSchema,
  listFilesOutputSchema,
  listFoldersOutputSchema,
  listUpcomingOutputSchema,
  type Course
} from './schemas.js';
import {
  fileIdFromPath,
  mapAnnouncement,
  mapAssignment,
  mapCourse,
  mapCourseMaterials,
  mapFile,
  mapFolder
} from './mappers.js';

const DEFAULT_COURSE_LIMIT = 20;
const UPCOMING_ASSIGNMENT_CONCURRENCY = 5;
const YEAR_REGEX = /(20\d{2})/;
const TERM_ORDER: Array<{ keyword: string; rank: number }> = [
  { keyword: 'winter', rank: 1 },
  { keyword: 'spring', rank: 2 },
  { keyword: 'summer', rank: 3 },
  { keyword: 'fall', rank: 4 },
  { keyword: 'autumn', rank: 4 },
  { keyword: 'fall-winter', rank: 5 }
];

export interface ToolDependencies {
  brightspace: BrightspaceClient;
}

interface ToolMeta {
  status?: number;
  requestId?: string;
  requestIds?: string[];
}

type ToolHandler<TArgs, TResult extends Record<string, unknown>> = (
  args: TArgs
) => Promise<{
  payload: TResult;
  meta: ToolMeta;
}>;

function toMcpError(error: AppError | Error): McpError {
  if (error instanceof AppError) {
    return new McpError(ErrorCode.InternalError, error.message, {
      code: error.code,
      ...error.data
    });
  }

  return new McpError(ErrorCode.InternalError, error.message ?? 'Unexpected error');
}

function wrapTool<TArgs, TResult extends Record<string, unknown>>(
  name: string,
  handler: ToolHandler<TArgs, TResult>
): (args: TArgs) => Promise<{ content: []; structuredContent: TResult }> {
  return async (args: TArgs) => {
    const start = Date.now();
    try {
      const { payload, meta } = await handler(args);
      logToolEvent('tool.completed', {
        tool: name,
        status: 'success',
        durationMs: Date.now() - start,
        brightspaceStatus: meta.status,
        requestId: meta.requestId,
        extraRequestIds: meta.requestIds
      });

      return {
        content: [],
        structuredContent: payload
      };
    } catch (error) {
      const duration = Date.now() - start;
      if (error instanceof AppError || error instanceof Error) {
        const wrapped = toMcpError(error);
        logToolEvent('tool.failed', {
          tool: name,
          status: 'error',
          durationMs: duration,
          brightspaceStatus: (error instanceof AppError && error.data?.brightspaceStatus) || undefined,
          requestId: (error instanceof AppError && error.data?.requestId) || undefined,
          error
        });
        throw wrapped;
      }

      logToolEvent('tool.failed', {
        tool: name,
        status: 'error',
        durationMs: duration,
        error: String(error)
      });
      throw new McpError(ErrorCode.InternalError, 'Unexpected error');
    }
  };
}

function createConcurrencyLimiter(maxConcurrent: number) {
  const limit = Math.max(1, Math.floor(maxConcurrent));
  let active = 0;
  const queue: Array<() => void> = [];

  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const execute = () => {
        active += 1;
        fn()
          .then(resolve)
          .catch(reject)
          .finally(() => {
            active -= 1;
            const next = queue.shift();
            if (next) {
              next();
            }
          });
      };

      if (active < limit) {
        execute();
      } else {
        queue.push(execute);
      }
    });
  };
}

function sortCoursesByRecency(courses: Course[]): Course[] {
  return [...courses].sort((a, b) => {
    const aInfo = courseRecencyInfo(a);
    const bInfo = courseRecencyInfo(b);

    if (aInfo.year !== bInfo.year) {
      return bInfo.year - aInfo.year;
    }

    if (aInfo.season !== bInfo.season) {
      return bInfo.season - aInfo.season;
    }

    return a.name.localeCompare(b.name);
  });
}

function filterRecentCourses(courses: Course[]): Course[] {
  const currentYear = new Date().getFullYear();
  const minYear = currentYear - 1;

  return courses.filter((course) => {
    const year = extractCourseYear(course);
    if (year === null) {
      return true;
    }
    return year >= minYear;
  });
}

function extractCourseYear(course: Course): number | null {
  const termYear = extractYear(course.term);
  if (termYear !== null) {
    return termYear;
  }

  return extractYear(course.course_code);
}

function extractYear(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const match = value.match(YEAR_REGEX);
  if (!match) {
    return null;
  }
  const year = Number(match[0]);
  return Number.isFinite(year) ? year : null;
}

function courseRecencyInfo(course: Course): { year: number; season: number } {
  const year = extractCourseYear(course) ?? -Infinity;
  const season = extractSeasonRank(course.term) ?? extractSeasonRank(course.course_code) ?? 0;
  return { year, season };
}

function extractSeasonRank(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const lower = value.toLowerCase();
  for (const { keyword, rank } of TERM_ORDER) {
    if (lower.includes(keyword)) {
      return rank;
    }
  }
  return null;
}

export function registerBrightspaceTools(server: McpServer, deps: ToolDependencies): void {
  registerListCourses(server, deps);
  registerListAssignments(server, deps);
  registerGetAssignment(server, deps);
  registerListAnnouncements(server, deps);
  registerCreateAnnouncement(server, deps);
  registerListUpcoming(server, deps);
  registerListCourseMaterials(server, deps);
  registerListCourseFiles(server, deps);
  registerListCourseFolders(server, deps);
  registerGetFileDownloadUrl(server, deps);
}

function registerListCourses(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    include_past: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional()
  };

  server.registerTool(
    'list_courses',
    {
      title: 'List Courses',
      description: 'List Brightspace courses for the authenticated user',
      inputSchema,
      outputSchema: listCoursesOutputSchema.shape
    },
    wrapTool(
      'list_courses',
      async (args: {
        include_past?: boolean;
        limit?: number;
      }) => {
        const params: Record<string, unknown> = {};
        if (!(args.include_past ?? false)) {
          params.isActive = true;
        }

        const { data, status, requestId, requestIds } =
          await deps.brightspace.getPagedResultSet<BrightspaceMyOrgUnitInfo>(
            deps.brightspace.lp('/enrollments/myenrollments/'),
            params
          );

        const includePast = args.include_past ?? false;
        const limit = args.limit ?? DEFAULT_COURSE_LIMIT;

        let courses = data
          .filter((entry) => entry.Access?.CanAccess !== false)
          .map(mapCourse);
        courses = sortCoursesByRecency(courses);

        if (!includePast) {
          courses = filterRecentCourses(courses);
        }

        if (limit) {
          courses = courses.slice(0, limit);
        }

        const payload = listCoursesOutputSchema.parse({
          courses
        });

        return {
          payload,
          meta: { status, requestId, requestIds }
        };
      }
    )
  );
}

function registerListAssignments(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    course_id: z.number().int().nonnegative(),
    due_after: z.string().datetime().optional(),
    due_before: z.string().datetime().optional(),
    search: z.string().trim().min(1).optional()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'list_assignments',
    {
      title: 'List Assignments',
      description: 'List assignments within a Brightspace course',
      inputSchema,
      outputSchema: listAssignmentsOutputSchema.shape
    },
    wrapTool(
      'list_assignments',
      async (args: {
        course_id: number;
        due_after?: string;
        due_before?: string;
        search?: string;
      }) => {
        const { data, status, requestId } = await deps.brightspace.get<unknown>(
          deps.brightspace.le(`/${args.course_id}/dropbox/folders/`)
        );

        const folders = normalizeArray<BrightspaceDropboxFolder>(data);

        const assignments = folders
          .filter((folder) => matchesAssignmentFilters(folder, args))
          .map((assignment) => mapAssignment(assignment, args.course_id));

        const payload = listAssignmentsOutputSchema.parse({ assignments });

        return {
          payload,
          meta: { status, requestId }
        };
      }
    )
  );
}

function registerGetAssignment(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    course_id: z.number().int().nonnegative(),
    assignment_id: z.number().int().nonnegative()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'get_assignment',
    {
      title: 'Get Assignment',
      description: 'Fetch a single assignment by id',
      inputSchema,
      outputSchema: getAssignmentOutputSchema.shape
    },
    wrapTool(
      'get_assignment',
      async (args: { course_id: number; assignment_id: number }) => {
        const { data, status, requestId } = await deps.brightspace.get<BrightspaceDropboxFolder>(
          deps.brightspace.le(`/${args.course_id}/dropbox/folders/${args.assignment_id}`)
        );

        const payload = getAssignmentOutputSchema.parse({
          assignment: mapAssignment(data, args.course_id)
        });

        return {
          payload,
          meta: { status, requestId }
        };
      }
    )
  );
}

function registerListAnnouncements(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    course_id: z.number().int().nonnegative().optional(),
    since: z.string().datetime().optional()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'list_announcements',
    {
      title: 'List Announcements',
      description: 'List announcements across Brightspace courses',
      inputSchema,
      outputSchema: listAnnouncementsOutputSchema.shape
    },
    wrapTool(
      'list_announcements',
      async (args: { course_id?: number; since?: string }) => {
        const requestIds: string[] = [];
        const statuses: number[] = [];

        const courseIds = await resolveCourseIds(deps, args.course_id, requestIds, statuses);
        if (courseIds.length === 0) {
          throw unknownError('No accessible Brightspace courses found for announcements.');
        }

        const limitFetch = createConcurrencyLimiter(UPCOMING_ASSIGNMENT_CONCURRENCY);
        const announcementResults = await Promise.all(
          courseIds.map((courseId) =>
            limitFetch(async () => {
              const params: Record<string, unknown> = {};
              if (args.since) {
                params.since = args.since;
              }

              const result = await deps.brightspace.get<unknown>(
                deps.brightspace.le(`/${courseId}/news/`),
                params
              );

              return { courseId, result };
            })
          )
        );

        const announcements: ReturnType<typeof mapAnnouncement>[] = [];

        for (const entry of announcementResults) {
          const { courseId, result } = entry;
          statuses.push(result.status);
          if (result.requestId) {
            requestIds.push(result.requestId);
          }

          const items = normalizeArray<BrightspaceNewsItem>(result.data);
          for (const item of items) {
            if (item.IsPublished === false) {
              continue;
            }
            announcements.push(mapAnnouncement(item, courseId));
          }
        }

        const payload = listAnnouncementsOutputSchema.parse({ announcements });

        return {
          payload,
          meta: {
            status: statuses.at(-1),
            requestId: requestIds.at(-1),
            requestIds
          }
        };
      }
    )
  );
}

function registerCreateAnnouncement(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    course_id: z.number().int().nonnegative(),
    title: z.string().trim().min(1),
    body: z.string().trim().min(1),
    is_published: z.boolean().optional().default(false)
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'create_announcement',
    {
      title: 'Create Announcement',
      description: 'Create a new announcement (news item) in a Brightspace course',
      inputSchema,
      outputSchema: createAnnouncementOutputSchema.shape
    },
    wrapTool(
      'create_announcement',
      async (args: {
        course_id: number;
        title: string;
        body: string;
        is_published: boolean;
      }) => {
        const { data, status, requestId } = await deps.brightspace.post<BrightspaceNewsItem>(
          deps.brightspace.le(`/${args.course_id}/news/`),
          {
            Title: args.title,
            Body: {
              Content: args.body,
              Type: 'Html'
            },
            StartDate: null,
            EndDate: null,
            IsPublished: args.is_published,
            IsPinned: false,
            ShowOnlyInCourseOfferings: false
          }
        );

        const payload = createAnnouncementOutputSchema.parse({
          announcement: mapAnnouncement(data, args.course_id)
        });

        return {
          payload,
          meta: { status, requestId }
        };
      }
    )
  );
}

function registerListUpcoming(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    days: z.number().int().min(1).max(30).optional(),
    max_courses: z.number().int().min(1).max(100).optional()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'list_upcoming',
    {
      title: 'List Upcoming Work',
      description: 'Combine Brightspace assignments sorted by due date',
      inputSchema,
      outputSchema: listUpcomingOutputSchema.shape
    },
    wrapTool('list_upcoming', async (args: { days?: number; max_courses?: number }) => {
      const rangeDays = args.days ?? 7;
      const now = new Date();
      const rangeEnd = new Date(now.getTime() + rangeDays * 24 * 60 * 60 * 1000);

      const upcomingMap = new Map<number, ReturnType<typeof mapAssignment>>();
      const metaRequestIds: string[] = [];
      const metaStatuses: number[] = [];

      const coursesResult = await deps.brightspace.getPagedResultSet<BrightspaceMyOrgUnitInfo>(
        deps.brightspace.lp('/enrollments/myenrollments/'),
        { isActive: true }
      );
      if (coursesResult.requestIds) {
        metaRequestIds.push(...coursesResult.requestIds);
      } else if (coursesResult.requestId) {
        metaRequestIds.push(coursesResult.requestId);
      }
      metaStatuses.push(coursesResult.status);

      const courseIds = coursesResult.data
        .filter((entry) => entry.Access?.CanAccess !== false)
        .map((entry) => entry.OrgUnit?.Id)
        .filter((id): id is number => typeof id === 'number');

      const maxCourses = args.max_courses ?? courseIds.length;
      const limitedCourses = courseIds.slice(0, maxCourses);

      const limitAssignments = createConcurrencyLimiter(UPCOMING_ASSIGNMENT_CONCURRENCY);

      type AssignmentSuccess = {
        courseId: number;
        assignmentsResult: BrightspaceResult<BrightspaceDropboxFolder[]>;
      };
      type AssignmentFailure = { courseId: number; error: unknown; isAuthFailure: boolean };
      type AssignmentFetchResult = AssignmentSuccess | AssignmentFailure;

      const assignmentResults: AssignmentFetchResult[] = await Promise.all(
        limitedCourses.map((courseId) =>
          limitAssignments(async () => {
            try {
              const { data, status, requestId } = await deps.brightspace.get<unknown>(
                deps.brightspace.le(`/${courseId}/dropbox/folders/`)
              );
              const normalized = normalizeArray<BrightspaceDropboxFolder>(data);
              return {
                courseId,
                assignmentsResult: { data: normalized, status, requestId }
              };
            } catch (error) {
              const isAuthFailure =
                error instanceof AppError && error.code === 'AUTHORIZATION_FAILED';
              if (isAuthFailure) {
                log('warn', 'Skipping course for upcoming assignments due to authorization error', {
                  course_id: courseId
                });
                return { courseId, error, isAuthFailure };
              }

              log('warn', 'Skipping course for upcoming assignments due to error', {
                course_id: courseId,
                error: error instanceof Error ? error.message : String(error),
                code: error instanceof AppError ? error.code : undefined
              });
              return { courseId, error, isAuthFailure: false };
            }
          })
        )
      );

      let assignmentSuccessCount = 0;
      let assignmentAuthFailureCount = 0;
      let assignmentNonAuthFailureCount = 0;

      for (const result of assignmentResults) {
        if (!('assignmentsResult' in result)) {
          if (result?.isAuthFailure) {
            assignmentAuthFailureCount += 1;
          } else if (result) {
            assignmentNonAuthFailureCount += 1;
          }
          continue;
        }

        const { courseId, assignmentsResult } = result;
        assignmentSuccessCount += 1;

        if (assignmentsResult.requestId) {
          metaRequestIds.push(assignmentsResult.requestId);
        }
        metaStatuses.push(assignmentsResult.status);

        for (const assignment of assignmentsResult.data) {
          const dueAt = assignment.DueDate ?? null;
          if (dueAt && !isWithinRange(dueAt, now, rangeEnd)) {
            continue;
          }

          const mapped = mapAssignment(assignment, courseId, 'assignment');

          if (!upcomingMap.has(mapped.id)) {
            upcomingMap.set(mapped.id, mapped);
          }
        }
      }

      if (limitedCourses.length > 0 && assignmentSuccessCount === 0) {
        const details = {
          courseCount: limitedCourses.length,
          authFailures: assignmentAuthFailureCount,
          nonAuthFailures: assignmentNonAuthFailureCount
        };
        if (assignmentNonAuthFailureCount > 0) {
          throw new AppError(
            'BRIGHTSPACE_UNAVAILABLE',
            'Failed to fetch upcoming assignments for all courses.',
            503,
            { details }
          );
        }
        throw new AppError(
          'AUTHORIZATION_FAILED',
          'Authorization failed for all courses when fetching assignments.',
          403,
          { details }
        );
      }

      const upcoming = Array.from(upcomingMap.values()).sort((a, b) => {
        const aTime = a.due_at ? Date.parse(a.due_at) : Number.POSITIVE_INFINITY;
        const bTime = b.due_at ? Date.parse(b.due_at) : Number.POSITIVE_INFINITY;
        return aTime - bTime;
      });

      const payload = listUpcomingOutputSchema.parse({ upcoming });

      return {
        payload,
        meta: {
          status: metaStatuses.at(-1),
          requestId: metaRequestIds.at(-1),
          requestIds: metaRequestIds
        }
      };
    })
  );
}

function registerListCourseMaterials(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    course_id: z.number().int().nonnegative()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'list_course_materials',
    {
      title: 'List Course Materials',
      description: 'List Brightspace course modules and topics from the content table of contents',
      inputSchema,
      outputSchema: listCourseMaterialsOutputSchema.shape
    },
    wrapTool('list_course_materials', async (args: { course_id: number }) => {
      const { data, status, requestId } = await deps.brightspace.get<BrightspaceContentToc>(
        deps.brightspace.le(`/${args.course_id}/content/toc`)
      );

      const modules = mapCourseMaterials(data?.Modules ?? []);
      const payload = listCourseMaterialsOutputSchema.parse({ modules });

      return {
        payload,
        meta: { status, requestId }
      };
    })
  );
}

function registerListCourseFiles(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    course_id: z.number().int().nonnegative(),
    path: z.string().optional()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'list_course_files',
    {
      title: 'List Course Files',
      description: 'List files within a Brightspace course',
      inputSchema,
      outputSchema: listFilesOutputSchema.shape
    },
    wrapTool('list_course_files', async (args: { course_id: number; path?: string }) => {
      const params: Record<string, unknown> = {};
      if (args.path) {
        params.path = args.path;
      }

      const { data, status, requestId, requestIds } =
        await deps.brightspace.getObjectListPage<BrightspaceFileSystemObject>(
          deps.brightspace.lp(`/${args.course_id}/managefiles/`),
          params
        );

      const basePath = normalizeBasePath(args.path);
      const files = data
        .filter((entry) => entry.FileSystemObjectType === 2)
        .map((entry) => mapFile({
          Name: entry.Name,
          path: joinPath(basePath, entry.Name)
        }));

      const payload = listFilesOutputSchema.parse({ files });

      return {
        payload,
        meta: { status, requestId, requestIds }
      };
    })
  );
}

function registerListCourseFolders(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    course_id: z.number().int().nonnegative(),
    path: z.string().optional()
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'list_course_folders',
    {
      title: 'List Course Folders',
      description: 'List all folders within a Brightspace course',
      inputSchema,
      outputSchema: listFoldersOutputSchema.shape
    },
    wrapTool('list_course_folders', async (args: { course_id: number; path?: string }) => {
      const params: Record<string, unknown> = {};
      if (args.path) {
        params.path = args.path;
      }

      const { data, status, requestId, requestIds } =
        await deps.brightspace.getObjectListPage<BrightspaceFileSystemObject>(
          deps.brightspace.lp(`/${args.course_id}/managefiles/`),
          params
        );

      const basePath = normalizeBasePath(args.path);
      const folders = data
        .filter((entry) => entry.FileSystemObjectType === 1)
        .map((entry) => mapFolder({
          Name: entry.Name,
          path: joinPath(basePath, entry.Name)
        }));

      const payload = listFoldersOutputSchema.parse({ folders });

      return {
        payload,
        meta: { status, requestId, requestIds }
      };
    })
  );
}

function registerGetFileDownloadUrl(server: McpServer, deps: ToolDependencies): void {
  const inputSchema = {
    course_id: z.number().int().nonnegative(),
    path: z.string().min(1)
  } satisfies Record<string, z.ZodTypeAny>;

  server.registerTool(
    'get_file_download_url',
    {
      title: 'Get File Download URL',
      description:
        'Get a download URL for a file path in Brightspace. The URL requires the same access token used for API calls.',
      inputSchema,
      outputSchema: getFileDownloadUrlOutputSchema.shape
    },
    wrapTool('get_file_download_url', async (args: { course_id: number; path: string }) => {
      const url = deps.brightspace.resolveUrl(
        deps.brightspace.lp(`/${args.course_id}/managefiles/file`),
        { path: args.path }
      );

      const payload = getFileDownloadUrlOutputSchema.parse({
        file_id: fileIdFromPath(args.path),
        download_url: url.toString(),
        path: args.path
      });

      return {
        payload,
        meta: { status: 200, requestId: undefined }
      };
    })
  );
}

function isWithinRange(
  isoDate: string | null | undefined,
  start: Date,
  end: Date
): boolean {
  if (!isoDate) {
    return false;
  }

  const timestamp = Date.parse(isoDate);
  if (Number.isNaN(timestamp)) {
    return false;
  }

  return timestamp >= start.getTime() && timestamp <= end.getTime();
}

function normalizeArray<T>(data: unknown): T[] {
  if (Array.isArray(data)) {
    return data as T[];
  }

  if (data && typeof data === 'object') {
    const anyData = data as Record<string, unknown>;
    if (Array.isArray(anyData.Items)) {
      return anyData.Items as T[];
    }
    if (Array.isArray(anyData.Objects)) {
      return anyData.Objects as T[];
    }
  }

  throw unknownError('Expected an array response from Brightspace.', data);
}

function normalizeBasePath(path?: string): string {
  if (!path) {
    return '';
  }

  let normalized = path.trim();
  if (!normalized) {
    return '';
  }

  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }

  if (normalized.endsWith('/') && normalized.length > 1) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

function joinPath(basePath: string, name: string): string {
  if (!basePath) {
    return name.startsWith('/') ? name : `/${name}`;
  }

  return `${basePath}/${name}`;
}

async function resolveCourseIds(
  deps: ToolDependencies,
  courseId: number | undefined,
  requestIds: string[],
  statuses: number[]
): Promise<number[]> {
  if (courseId) {
    return [courseId];
  }

  const coursesResult = await deps.brightspace.getPagedResultSet<BrightspaceMyOrgUnitInfo>(
    deps.brightspace.lp('/enrollments/myenrollments/'),
    { isActive: true }
  );
  if (coursesResult.requestIds) {
    requestIds.push(...coursesResult.requestIds);
  } else if (coursesResult.requestId) {
    requestIds.push(coursesResult.requestId);
  }
  statuses.push(coursesResult.status);

  return coursesResult.data
    .filter((entry) => entry.Access?.CanAccess !== false)
    .map((entry) => entry.OrgUnit?.Id)
    .filter((id): id is number => typeof id === 'number');
}

function matchesAssignmentFilters(
  assignment: BrightspaceDropboxFolder,
  filters: { due_after?: string; due_before?: string; search?: string }
): boolean {
  if (filters.search) {
    const term = filters.search.toLowerCase();
    if (!assignment.Name.toLowerCase().includes(term)) {
      return false;
    }
  }

  const dueAt = assignment.DueDate ?? null;
  if (filters.due_after) {
    const after = Date.parse(filters.due_after);
    const due = dueAt ? Date.parse(dueAt) : NaN;
    if (Number.isFinite(after) && Number.isFinite(due) && due < after) {
      return false;
    }
  }

  if (filters.due_before) {
    const before = Date.parse(filters.due_before);
    const due = dueAt ? Date.parse(dueAt) : NaN;
    if (Number.isFinite(before) && Number.isFinite(due) && due > before) {
      return false;
    }
  }

  return true;
}
