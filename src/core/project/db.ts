import Dexie, { type EntityTable } from 'dexie';
import type { TaskSnapshot } from '../../types/models';

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

export type ProjectArtifactKind = 'english-pdf';

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

  constructor(name = 'paper-parallel') {
    super(name);
    this.version(1).stores({
      tasks: 'projectId,updatedAt',
      translations: 'key,projectId,blockId',
      artifacts: 'key,projectId,kind',
    });
  }
}
