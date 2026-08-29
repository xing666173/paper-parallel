import Dexie, { type EntityTable } from 'dexie';
import type { TaskSnapshot } from '../../types/models';
import type { AiLogEvent } from '../translate/events';

export interface ProjectAiLogEntry {
  at: number;
  type: AiLogEvent['type'];
  batchId?: string;
  page?: number;
  totalPages?: number;
  reviewedPages?: number;
  message: string;
}

export interface ProjectAiLogRecord {
  projectId: string;
  entries: ProjectAiLogEntry[];
  updatedAt: number;
}

export interface TranslationAlignmentGroupRecord {
  sourceSentenceIds: string[];
  targetSegments: string[];
}

export interface TranslationCacheRecord {
  key: string;
  projectId: string;
  blockId: string;
  translation: string;
  alignmentGroups: TranslationAlignmentGroupRecord[];
  validatedAt: number;
}

export type ProjectArtifactKind =
  | 'english-pdf'
  | 'chinese-pdf'
  | 'typst-source'
  | 'typst-preview'
  | 'alignment-manifest'
  | 'vision-layout'
  | 'project-package';

export interface ProjectArtifactRecord {
  key: string;
  projectId: string;
  kind: ProjectArtifactKind;
  blob: Blob;
  updatedAt: number;
}

export class PaperParallelDb extends Dexie {
  tasks!: EntityTable<TaskSnapshot, 'projectId'>;
  translations!: EntityTable<TranslationCacheRecord, 'key'>;
  artifacts!: EntityTable<ProjectArtifactRecord, 'key'>;
  aiLogs!: EntityTable<ProjectAiLogRecord, 'projectId'>;

  constructor(name = 'paper-parallel') {
    super(name);
    this.version(1).stores({
      tasks: 'projectId,updatedAt',
      translations: 'key,projectId,blockId',
      artifacts: 'key,projectId,kind',
    });
    this.version(2).stores({
      tasks: 'projectId,updatedAt',
      translations: 'key,projectId,blockId',
      artifacts: 'key,projectId,kind',
      aiLogs: 'projectId,updatedAt',
    });
  }
}
