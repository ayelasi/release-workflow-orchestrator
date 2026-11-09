// Simulates build verification and returns a version-dependent result.
import { runTask } from '../shared/task-utils';

export const handler = async (event: unknown) =>
  runTask('B1', 'Lambda B1', event, (release) => {
    if (release.version === 'beta') {
      return {
        outcome: 'WARNING',
        message: 'vulnerabilities found',
      };
    }

    return { outcome: 'SUCCESS', message: 'Build verification passed' };
  });
