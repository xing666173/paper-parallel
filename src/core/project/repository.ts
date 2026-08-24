import type { TaskSnapshot } from '../../types/models';
import {
  PaperParallelDb,
  type ProjectArtifactRecord,
  type TranslationCacheRecord,
} from './db';

export interface ProjectRepository {
  saveTask(task: TaskSnapshot): Promise<void>;
  loadTask(projectId: string): Promise<TaskSnapshot | undefined>;
  putTranslation(record: TranslationCacheRecord): Promise<void>;
  findTranslation(key: string): Promise<TranslationCacheRecord | undefined>;
  clearProjectTranslation(projectId: string): Promise<void>;
  putArtifact(record: ProjectArtifactRecord): Promise<void>;
  findArtifact(key: string): Promise<ProjectArtifactRecord | undefined>;
}

export function createProjectRepository(name = 'paper-parallel'): ProjectRepository {
  const db = new PaperParallelDb(name);

  return {
    async saveTask(task) {
      await db.tasks.put(task);
    },

    async loadTask(projectId) {
      return db.tasks.get(projectId);
    },

    async putTranslation(record) {
      await db.translations.put(record);
    },

    async findTranslation(key) {
      return db.translations.get(key);
    },

    async clearProjectTranslation(projectId) {
      await db.translations.where('projectId').equals(projectId).delete();
    },

    async putArtifact(record) {
      await db.artifacts.put(record);
    },

    async findArtifact(key) {
      return db.artifacts.get(key);
    },
  };
}
