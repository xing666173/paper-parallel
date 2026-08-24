import type { TaskSnapshot } from '../../types/models';
import type { AlignmentManifest } from '../align/manifest';
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
  saveAlignmentManifest(manifest: AlignmentManifest): Promise<void>;
  loadAlignmentManifest(projectId: string): Promise<AlignmentManifest | undefined>;
  clearProjectDerivedData(projectId: string): Promise<void>;
}

export function createProjectRepository(name = 'paper-parallel'): ProjectRepository {
  const db = new PaperParallelDb(name);

  return {
    async saveTask(task) {
      await db.tasks.put({
        ...task,
        progress: { ...task.progress },
      });
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

    async saveAlignmentManifest(manifest) {
      await db.artifacts.put({
        key: `${manifest.projectId}:alignment-manifest`,
        projectId: manifest.projectId,
        kind: 'alignment-manifest',
        blob: new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
        updatedAt: manifest.createdAt,
      });
    },

    async loadAlignmentManifest(projectId) {
      const record = await db.artifacts.get(`${projectId}:alignment-manifest`);
      if (!record) return undefined;
      return JSON.parse(await record.blob.text()) as AlignmentManifest;
    },

    async clearProjectDerivedData(projectId) {
      await db.transaction('rw', db.translations, db.artifacts, async () => {
        await db.translations.where('projectId').equals(projectId).delete();
        const artifacts = await db.artifacts.where('projectId').equals(projectId).toArray();
        const derivedKeys = artifacts
          .filter((artifact) => artifact.kind !== 'english-pdf')
          .map((artifact) => artifact.key);
        if (derivedKeys.length) await db.artifacts.bulkDelete(derivedKeys);
      });
    },
  };
}
