// Verifies task release rules, output metadata, logging, and configurable delays.
import { handler as validationHandler } from '../lambdas/a-validation';
import { handler as buildVerificationHandler } from '../lambdas/b1-build-verify';
import { handler as releaseCompletionHandler } from '../lambdas/c-release-complete';

const approvedLatestRelease = {
  version: 'latest',
  environment: 'SIT',
  approved: true,
};

describe('task Lambda handlers', () => {
  const originalSleep = process.env.TASK_SLEEP_SECONDS;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.TASK_SLEEP_SECONDS = '0';
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    logSpy.mockRestore();
    if (originalSleep === undefined) {
      delete process.env.TASK_SLEEP_SECONDS;
    } else {
      process.env.TASK_SLEEP_SECONDS = originalSleep;
    }
  });

  it('validates release input and logs Lambda A once', async () => {
    const result = await validationHandler(approvedLatestRelease);
    expect(result).toMatchObject({
      taskId: 'A',
      outcome: 'SUCCESS',
      message: 'Release validation passed',
    });
    expect(result.durationMs).toEqual(expect.any(Number));
    expect(Date.parse(result.startedAt)).not.toBeNaN();
    expect(Date.parse(result.finishedAt)).not.toBeNaN();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('Lambda A');
  });

  it.each([
    [
      { ...approvedLatestRelease, version: 'beta', environment: 'PROD' },
      'Beta releases are not allowed in PROD',
    ],
    [
      { ...approvedLatestRelease, version: 'beta', approved: false },
      'Beta releases require approval',
    ],
    [
      { ...approvedLatestRelease, environment: 'PROD', approved: false },
      'PROD releases require approval',
    ],
  ])('returns FAILURE for invalid release policy: %s', async (input, message) => {
    const result = await validationHandler(input);
    expect(result.outcome).toBe('FAILURE');
    expect(result.message).toBe(message);
  });

  it('warns for beta builds and succeeds for latest builds', async () => {
    const betaResult = await buildVerificationHandler({
      ...approvedLatestRelease,
      version: 'beta',
    });
    const latestResult = await buildVerificationHandler(approvedLatestRelease);

    expect(betaResult).toMatchObject({
      taskId: 'B1',
      outcome: 'WARNING',
      message: 'vulnerabilities found',
    });
    expect(latestResult.outcome).toBe('SUCCESS');
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenNthCalledWith(1, 'Lambda B1');
    expect(logSpy).toHaveBeenNthCalledWith(2, 'Lambda B1');
  });

  it('completes successfully and logs Lambda C once', async () => {
    const result = await releaseCompletionHandler(approvedLatestRelease);

    expect(result).toMatchObject({
      taskId: 'C',
      outcome: 'SUCCESS',
      message: 'Release completed',
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('Lambda C');
  });

  it('rejects invalid input and an invalid sleep duration', async () => {
    await expect(validationHandler({})).rejects.toThrow(
      'Release input version must be latest or beta',
    );

    process.env.TASK_SLEEP_SECONDS = '11';
    await expect(validationHandler(approvedLatestRelease)).rejects.toThrow(
      'Invalid task sleep duration',
    );
  });

  it('uses random delays from 1 to 10 seconds for Node.js tasks', async () => {
    delete process.env.TASK_SLEEP_SECONDS;
    jest.useFakeTimers();
    const timeoutSpy = jest.spyOn(global, 'setTimeout');
    const randomSpy = jest.spyOn(Math, 'random');
    randomSpy
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999999)
      .mockReturnValueOnce(0.5);

    const tasks = [
      validationHandler(approvedLatestRelease),
      buildVerificationHandler(approvedLatestRelease),
      releaseCompletionHandler(approvedLatestRelease),
    ];

    expect(timeoutSpy.mock.calls.map(([, delay]) => delay)).toEqual([
      1000,
      10000,
      6000,
    ]);
    await jest.advanceTimersByTimeAsync(10000);
    await Promise.all(tasks);
  });
});
