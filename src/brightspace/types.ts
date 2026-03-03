export interface BrightspaceMyOrgUnitInfo {
  OrgUnit: {
    Id: number;
    Name?: string | null;
    Code?: string | null;
    Type?: {
      Id?: number;
      Code?: string;
      Name?: string;
    } | null;
    HomeUrl?: string | null;
  };
  Access?: {
    CanAccess?: boolean;
  } | null;
}

export interface BrightspaceDropboxFolder {
  Id: number;
  Name: string;
  DueDate?: string | null;
  Availability?: {
    StartDate?: string | null;
    EndDate?: string | null;
  } | null;
  NotificationEmail?: string | null;
  GradeItemId?: number | null;
}

export interface BrightspaceNewsItem {
  Id: number;
  Title: string;
  Body?: string | null;
  StartDate?: string | null;
  EndDate?: string | null;
  CreatedDate?: string | null;
  LastModifiedDate?: string | null;
  IsPublished?: boolean;
  IsPinned?: boolean;
}

export interface BrightspaceContentToc {
  Modules?: BrightspaceContentModule[] | null;
}

export interface BrightspaceContentModule {
  ModuleId: number;
  Title: string;
  StartDateTime?: string | null;
  EndDateTime?: string | null;
  Modules?: BrightspaceContentModule[] | null;
  Topics?: BrightspaceContentTopic[] | null;
}

export interface BrightspaceContentTopic {
  TopicId: number;
  Title: string;
  Url?: string | null;
  TypeIdentifier?: string | null;
  StartDateTime?: string | null;
  EndDateTime?: string | null;
  IsHidden?: boolean;
  IsLocked?: boolean;
  IsBroken?: boolean;
  ActivityType?: string | number | null;
}

export interface BrightspaceFileSystemObject {
  Name: string;
  FileSystemObjectType: number; // 1=Folder, 2=File
}
