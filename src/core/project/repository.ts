import type { TaskSnapshot } from '../../types/models';
import type { AlignmentManifest } from '../align/manifest';
import {
  PaperParallelDb,
  type ProjectAiLogEntry,
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
  listProjectTranslations(projectId: string): Promise<TranslationCacheRecord[]>;
  listProjectArtifacts(projectId: string): Promise<ProjectArtifactRecord[]>;
  saveAiLog(projectId: string, entries: ProjectAiLogEntry[]): Promise<void>;
  loadAiLog(projectId: string): Promise<ProjectAiLogEntry[]>;
  clearAiLog(projectId: string): Promise<void>;
}

export function createProjectRepository(name = 'paper-parallel'): ProjectRepository {
  const db = new PaperParallelDb(name);

  return {
    async saveTask(task) {
      await db.tasks.put({
        projectId: task.projectId,
        stage: task.stage,
        status: task.status,
        progress: { ...task.progress },
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        updatedAt: task.updatedAt,
        error: task.error,
        settings: task.settings ? { ...task.settings } : undefined,
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
      await db.transaction('rw', db.translations, db.artifacts, db.aiLogs, async () => {
        await db.translations.where('projectId').equals(projectId).delete();
        await db.aiLogs.delete(projectId);
        const artifacts = await db.artifacts.where('projectId').equals(projectId).toArray();
        const derivedKeys = artifacts
          .filter((artifact) => artifact.kind !== 'english-pdf')
          .map((artifact) => artifact.key);
        if (derivedKeys.length) await db.artifacts.bulkDelete(derivedKeys);
      });
    },

    async listProjectTranslations(projectId) {
      return db.translations.where('projectId').equals(projectId).sortBy('blockId');
    },

    async listProjectArtifacts(projectId) {
      return db.artifacts.where('projectId').equals(projectId).sortBy('kind');
    },

    async saveAiLog(projectId, entries) {
      await db.aiLogs.put({
        projectId,
        entries: entries.map((entry) => ({ ...entry })),
        updatedAt: Date.now(),
      });
    },

    async loadAiLog(projectId) {
      const record = await db.aiLogs.get(projectId);
      return record?.entries.map((entry) => ({ ...entry })) ?? [];
    },

    async clearAiLog(projectId) {
      await db.aiLogs.delete(projectId);
    },
  };
}
