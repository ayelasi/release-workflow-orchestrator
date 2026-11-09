// Verifies pure workflow status and dependency transition rules.
import {
  decidePendingTasks,
  deriveWorkflowStatus,
  TaskState,
  TaskStatus,
} from '../lib/workflow-decision';

const taskGraph: TaskState[] = [
  { taskId: 'A', status: 'PENDING', dependencies: [] },
  { taskId: 'B1', status: 'PENDING', dependencies: ['A'] },
  { taskId: 'B2', status: 'PENDING', dependencies: ['A'] },
  { taskId: 'B3', status: 'PENDING', dependencies: ['A'] },
  { taskId: 'C', status: 'PENDING', dependencies: ['B1', 'B2', 'B3'] },
];

const withStatuses = (
  statuses: Partial<Record<string, TaskStatus>>,
): TaskState[] =>
  taskGraph.map((task) => ({
    ...task,
    status: statuses[task.taskId] ?? task.status,
  }));

describe('decidePendingTasks', () => {
  it('readies only the root task for a new workflow', () => {
    expect(decidePendingTasks(taskGraph)).toEqual({
      readyTaskIds: ['A'],
      skippedTasks: [],
    });
  });

  it('readies the three parallel tasks after A completes', () => {
    expect(decidePendingTasks(withStatuses({ A: 'COMPLETED' }))).toEqual({
      readyTaskIds: ['B1', 'B2', 'B3'],
      skippedTasks: [],
    });
  });

  it('treats a warning completion as a satisfied dependency', () => {
    expect(
      decidePendingTasks(withStatuses({ A: 'COMPLETED_WITH_WARNINGS' })),
    ).toEqual({
      readyTaskIds: ['B1', 'B2', 'B3'],
      skippedTasks: [],
    });
  });

  it('readies C only when all parallel dependencies are satisfied', () => {
    expect(
      decidePendingTasks(
        withStatuses({
          A: 'COMPLETED',
          B1: 'COMPLETED',
          B2: 'COMPLETED_WITH_WARNINGS',
          B3: 'COMPLETED',
        }),
      ),
    ).toEqual({
      readyTaskIds: ['C'],
      skippedTasks: [],
    });
  });

  it('does not ready a task while any dependency is still running', () => {
    expect(
      decidePendingTasks(
        withStatuses({
          A: 'COMPLETED',
          B1: 'COMPLETED',
          B2: 'RUNNING',
          B3: 'COMPLETED',
        }),
      ).readyTaskIds,
    ).toEqual([]);
  });

  it('skips dependents transitively when a dependency fails', () => {
    const reverseOrderedGraph = [...taskGraph].reverse();
    const failedWorkflow = reverseOrderedGraph.map((task) => ({
      ...task,
      status: task.taskId === 'A' ? 'FAILED' as const : task.status,
    }));

    expect(decidePendingTasks(failedWorkflow)).toEqual({
      readyTaskIds: [],
      skippedTasks: [
        {
          taskId: 'C',
          reason: 'Dependency failed or was skipped: B1, B2, B3',
        },
        { taskId: 'B3', reason: 'Dependency failed or was skipped: A' },
        { taskId: 'B2', reason: 'Dependency failed or was skipped: A' },
        { taskId: 'B1', reason: 'Dependency failed or was skipped: A' },
      ],
    });
  });

  it('skips C if any parallel dependency failed', () => {
    expect(
      decidePendingTasks(
        withStatuses({
          A: 'COMPLETED',
          B1: 'FAILED',
          B2: 'COMPLETED',
          B3: 'COMPLETED_WITH_WARNINGS',
        }),
      ),
    ).toEqual({
      readyTaskIds: [],
      skippedTasks: [
        { taskId: 'C', reason: 'Dependency failed or was skipped: B1' },
      ],
    });
  });

  it('rejects duplicate task IDs and missing dependencies', () => {
    expect(() =>
      decidePendingTasks([
        ...taskGraph,
        { taskId: 'A', status: 'PENDING', dependencies: [] },
      ]),
    ).toThrow('Duplicate task ID in workflow: A');

    expect(() =>
      decidePendingTasks([
        { taskId: 'B1', status: 'PENDING', dependencies: ['missing'] },
      ]),
    ).toThrow('Task B1 references missing dependency missing');
  });
});

describe('deriveWorkflowStatus', () => {
  it('keeps the workflow running while any task is pending or running', () => {
    expect(
      deriveWorkflowStatus([
        'COMPLETED',
        'COMPLETED_WITH_WARNINGS',
        'PENDING',
      ]),
    ).toBe('RUNNING');

    expect(deriveWorkflowStatus(['COMPLETED', 'RUNNING'])).toBe('RUNNING');
  });

  it('derives failed before warning when all tasks are terminal', () => {
    expect(
      deriveWorkflowStatus([
        'COMPLETED_WITH_WARNINGS',
        'FAILED',
        'SKIPPED',
      ]),
    ).toBe('FAILED');
  });

  it('derives warnings when no task failed and at least one warned', () => {
    expect(
      deriveWorkflowStatus([
        'COMPLETED',
        'COMPLETED_WITH_WARNINGS',
        'SKIPPED',
      ]),
    ).toBe('COMPLETED_WITH_WARNINGS');
  });

  it('derives completed when all tasks completed without warnings', () => {
    expect(
      deriveWorkflowStatus([
        'COMPLETED',
        'COMPLETED',
        'COMPLETED',
      ]),
    ).toBe('COMPLETED');
  });

  it('rejects an empty task list', () => {
    expect(() => deriveWorkflowStatus([])).toThrow(
      'Cannot derive workflow status without task statuses',
    );
  });
});
