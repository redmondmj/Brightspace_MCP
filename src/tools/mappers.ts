import {
  BrightspaceContentModule,
  BrightspaceContentTopic,
  BrightspaceDropboxFolder,
  BrightspaceMyOrgUnitInfo,
  BrightspaceNewsItem
} from '../brightspace/types.js';
import {
  Announcement,
  Assignment,
  Course,
  CourseMaterialModule,
  CourseMaterialTopic,
  FileResource,
  Folder,
  UpcomingItem
} from './schemas.js';
import { toBrightspaceTimezone } from '../core/timezone.js';

function normalizeTerm(term?: string | null): string {
  return term?.trim() ?? '';
}

function normalizeCourseCode(code?: string | null, id?: number): string {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (trimmed) {
    return trimmed;
  }
  if (typeof id === 'number' && Number.isFinite(id)) {
    return `COURSE-${id}`;
  }
  return 'COURSE-UNKNOWN';
}

export function mapCourse(raw: BrightspaceMyOrgUnitInfo): Course {
  const orgUnit = raw.OrgUnit;
  const id = orgUnit?.Id ?? 0;
  const name = typeof orgUnit?.Name === 'string' && orgUnit.Name.trim()
    ? orgUnit.Name.trim()
    : normalizeCourseCode(orgUnit?.Code ?? null, id);

  return {
    id,
    name,
    term: normalizeTerm(orgUnit?.Type?.Name ?? null),
    course_code: normalizeCourseCode(orgUnit?.Code ?? null, id)
  };
}

export function mapAssignment(raw: BrightspaceDropboxFolder, courseId: number, source?: 'todo' | 'assignment'):
  | Assignment
  | UpcomingItem {
  const base: Assignment = {
    id: raw.Id,
    course_id: courseId,
    name: raw.Name,
    due_at: toBrightspaceTimezone(raw.DueDate ?? null) ?? null,
    points: null,
    html_url: ''
  };

  if (!source) {
    return base;
  }

  return {
    ...base,
    source
  } satisfies UpcomingItem;
}

export function mapAnnouncement(raw: BrightspaceNewsItem, courseId: number): Announcement {
  const postedAt = raw.StartDate ?? raw.CreatedDate ?? raw.LastModifiedDate ?? null;

  return {
    id: raw.Id,
    course_id: courseId,
    title: raw.Title,
    posted_at: toBrightspaceTimezone(postedAt) ?? postedAt ?? '',
    html_url: ''
  };
}

export function mapCourseMaterials(modules: BrightspaceContentModule[] | null | undefined): CourseMaterialModule[] {
  if (!modules || modules.length === 0) {
    return [];
  }

  return modules.map(mapModule);
}

function mapModule(module: BrightspaceContentModule): CourseMaterialModule {
  return {
    id: module.ModuleId,
    title: module.Title,
    start_at: toBrightspaceTimezone(module.StartDateTime ?? null) ?? module.StartDateTime ?? null,
    end_at: toBrightspaceTimezone(module.EndDateTime ?? null) ?? module.EndDateTime ?? null,
    modules: mapCourseMaterials(module.Modules),
    topics: (module.Topics ?? []).map(mapTopic)
  };
}

function mapTopic(topic: BrightspaceContentTopic): CourseMaterialTopic {
  return {
    id: topic.TopicId,
    title: topic.Title,
    url: topic.Url ?? undefined,
    type: topic.TypeIdentifier ?? undefined,
    start_at: toBrightspaceTimezone(topic.StartDateTime ?? null) ?? topic.StartDateTime ?? null,
    end_at: toBrightspaceTimezone(topic.EndDateTime ?? null) ?? topic.EndDateTime ?? null,
    is_hidden: topic.IsHidden ?? undefined,
    is_locked: topic.IsLocked ?? undefined,
    is_broken: topic.IsBroken ?? undefined,
    activity_type: topic.ActivityType ?? undefined
  };
}

export function mapFile(raw: { Name: string; path: string }): FileResource {
  return {
    id: fileIdFromPath(raw.path),
    display_name: raw.Name,
    filename: raw.Name,
    path: raw.path
  };
}

export function mapFolder(raw: { Name: string; path: string }): Folder {
  return {
    id: fileIdFromPath(raw.path),
    name: raw.Name,
    full_name: raw.path,
    path: raw.path
  };
}

export function fileIdFromPath(path: string): number {
  let hash = 0;
  for (let i = 0; i < path.length; i += 1) {
    hash = (hash * 31 + path.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}
