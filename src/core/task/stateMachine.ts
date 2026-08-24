import type { TaskSnapshot } from '../../types/models';

export type TaskEvent =
  | { type: 'START_PARSE'; at: number }
  | { type: 'PARSE_DONE'; at: number }
  | { type: 'START_TRANSLATION'; total: number; at: number }
  | { type: 'BLOCKS_VALIDATED'; count: number; at: number }
  | { type: 'STOP_REQUESTED'; at: number }
  | { type: 'STOPPED'; at: number }
  | { type: 'RESUME'; at: number }
  | { type: 'FAILED'; error: string; at: number }
  | { type: 'QUALITY_PASSED'; at: number };

export function createTaskSnapshot(projectId: string, at = Date.now()): TaskSnapshot {
  return {
    projectId,
    stage: 'idle',
    status: 'idle',
    progress: { completed: 0, total: 0, retries: 0, failed: 0 },
    createdAt: at,
    updatedAt: at,
  };
}

export function reduceTaskEvent(state: TaskSnapshot, event: TaskEvent): TaskSnapshot {
  if (event.type === 'START_PARSE' && state.stage === 'idle') {
    return {
      ...state,
      stage: 'parsing',
      status: 'running',
      startedAt: event.at,
      updatedAt: event.at,
    };
  }

  if (event.type === 'PARSE_DONE' && state.stage === 'parsing') {
    return { ...state, stage: 'analyzing-layout', updatedAt: event.at };
  }

  if (event.type === 'START_TRANSLATION') {
    return {
      ...state,
      stage: 'translating',
      status: 'running',
      progress: { completed: 0, total: event.total, retries: 0, failed: 0 },
      startedAt: state.startedAt ?? event.at,
      updatedAt: event.at,
    };
  }

  if (event.type === 'BLOCKS_VALIDATED' && state.stage === 'translating') {
    return {
      ...state,
      progress: { ...state.progress, completed: state.progress.completed + event.count },
      updatedAt: event.at,
    };
  }

  if (event.type === 'STOP_REQUESTED' && state.status === 'running') {
    return { ...state, status: 'stopping', updatedAt: event.at };
  }

  if (event.type === 'STOPPED' && state.status === 'stopping') {
    return { ...state, status: 'stopped', updatedAt: event.at };
  }

  if (event.type === 'RESUME' && state.status === 'stopped') {
    return { ...state, status: 'running', updatedAt: event.at };
  }

  if (event.type === 'FAILED') {
    return { ...state, status: 'failed', error: event.error, updatedAt: event.at };
  }

  if (event.type === 'QUALITY_PASSED' && state.stage === 'validating') {
    return { ...state, stage: 'completed', status: 'completed', updatedAt: event.at };
  }

  throw new Error(`${event.type} is invalid from ${state.stage}`);
}
