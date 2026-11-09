// Validates release input against the release policy.
import { runTask } from '../shared/task-utils';

export const handler = async (event: unknown) =>
  runTask('A', 'Lambda A', event, (release) => {
    if (release.version === 'beta' && release.environment === 'PROD') {
      return {
        outcome: 'FAILURE',
        message: 'Beta releases are not allowed in PROD',
      };
    }

    if (release.version === 'beta' && !release.approved) {
      return {
        outcome: 'FAILURE',
        message: 'Beta releases require approval',
      };
    }

    if (release.environment === 'PROD' && !release.approved) {
      return {
        outcome: 'FAILURE',
        message: 'PROD releases require approval',
      };
    }

    return { outcome: 'SUCCESS', message: 'Release validation passed' };
  });
