// Defines stable task IDs, labels, and DAG dependencies.
export type TaskId = 'A' | 'B1' | 'B2' | 'B3' | 'C';

export interface TaskDefinition {
  taskId: TaskId;
  label: string;
  dependencies: readonly TaskId[];
}

export const TASK_DEFINITIONS: readonly TaskDefinition[] = [
  { taskId: 'A', label: 'Validation', dependencies: [] },
  { taskId: 'B1', label: 'Build Verification', dependencies: ['A'] },
  { taskId: 'B2', label: 'Artifact Verification', dependencies: ['A'] },
  { taskId: 'B3', label: 'Security Scan', dependencies: ['A'] },
  { taskId: 'C', label: 'Release Completion', dependencies: ['B1', 'B2', 'B3'] },
];
