// Contains pure DAG dependency and workflow-status decision logic.
export type TaskStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'COMPLETED_WITH_WARNINGS'
  | 'FAILED'
  | 'SKIPPED';

export type WorkflowStatus =
  | 'RUNNING'
  | 'COMPLETED'
  | 'COMPLETED_WITH_WARNINGS'
  | 'FAILED';

export interface TaskState {
  taskId: string;
  status: TaskStatus;
  dependencies: readonly string[];
}

export interface TaskDecisions {
  readyTaskIds: string[];
  skippedTasks: Array<{
    taskId: string;
    reason: string;
  }>;
}

const isSatisfied = (status: TaskStatus): boolean =>
  status === 'COMPLETED' || status === 'COMPLETED_WITH_WARNINGS';

const isTerminal = (status: TaskStatus): boolean =>
  status !== 'PENDING' && status !== 'RUNNING';

/**
 * Determine which pending tasks can run or must be skipped from a workflow snapshot.
 * The input is never mutated; skip decisions are propagated through dependents.
 */
export function decidePendingTasks(tasks: readonly TaskState[]): TaskDecisions {
  const statusByTaskId = new Map<string, TaskStatus>();

  for (const task of tasks) {
    if (statusByTaskId.has(task.taskId)) {
      throw new Error(`Duplicate task ID in workflow: ${task.taskId}`);
    }

    statusByTaskId.set(task.taskId, task.status);
  }

  for (const task of tasks) {
    for (const dependencyId of task.dependencies) {
      if (!statusByTaskId.has(dependencyId)) {
        throw new Error(
          `Task ${task.taskId} references missing dependency ${dependencyId}`,
        );
      }
    }
  }

  const skippedReasons = new Map<string, string>();
  let hasNewSkips = true;

  while (hasNewSkips) {
    hasNewSkips = false;

    for (const task of tasks) {
      if (statusByTaskId.get(task.taskId) !== 'PENDING') {
        continue;
      }

      const failedDependencies = task.dependencies.filter((dependencyId) => {
        const status = statusByTaskId.get(dependencyId);
        return status === 'FAILED' || status === 'SKIPPED';
      });

      if (failedDependencies.length > 0) {
        statusByTaskId.set(task.taskId, 'SKIPPED');
        skippedReasons.set(
          task.taskId,
          `Dependency failed or was skipped: ${failedDependencies.join(', ')}`,
        );
        hasNewSkips = true;
      }
    }
  }

  const readyTaskIds = tasks
    .filter(
      (task) =>
        statusByTaskId.get(task.taskId) === 'PENDING' &&
        task.dependencies.every((dependencyId) => {
          const dependencyStatus = statusByTaskId.get(dependencyId);
          return dependencyStatus !== undefined && isSatisfied(dependencyStatus);
        }),
    )
    .map((task) => task.taskId);

  return {
    readyTaskIds,
    skippedTasks: tasks.flatMap((task) => {
      const reason = skippedReasons.get(task.taskId);
      return reason === undefined ? [] : [{ taskId: task.taskId, reason }];
    }),
  };
}

/**
 * Derive workflow status after observing all task statuses.
 */
export function deriveWorkflowStatus(
  taskStatuses: readonly TaskStatus[],
): WorkflowStatus {
  if (taskStatuses.length === 0) {
    throw new Error('Cannot derive workflow status without task statuses');
  }

  if (taskStatuses.some((status) => !isTerminal(status))) {
    return 'RUNNING';
  }

  if (taskStatuses.includes('FAILED')) {
    return 'FAILED';
  }

  if (taskStatuses.includes('COMPLETED_WITH_WARNINGS')) {
    return 'COMPLETED_WITH_WARNINGS';
  }

  return 'COMPLETED';
}
