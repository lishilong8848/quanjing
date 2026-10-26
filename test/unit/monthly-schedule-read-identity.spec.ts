describe('monthly schedule reads across authorization changes', () => {
  function factory() {
    return require('../../client/src/pages/MonthlySchedule/schedule-read-cache').createScheduleReadCache;
  }

  it('does not reuse the guest in-flight failure after authorization', async () => {
    let reject!: (error: Error) => void;
    const read = jest.fn()
      .mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
      .mockResolvedValueOnce({ schedules: [{ name: '合成人员' }] });
    const select = factory()(read);
    const guest = select('anonymous'), previous = guest.read(2026, 10);
    const oldResult = previous.catch((error: Error) => error.message);
    const employee = select('signed-person-1');
    await expect(employee.read(2026, 10)).resolves.toEqual({ schedules: [{ name: '合成人员' }] });
    reject(new Error('old guest request failed'));
    expect(await oldResult).toBe('old guest request failed');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('isolates cached rows across guest and signed identities', () => {
    const select = factory()(jest.fn());
    const employee = select('signed-person-1');
    employee.cache.set('2026-10', { schedules: [{ name: 'private synthetic row' }], fetchedAt: 1 });
    const guest = select('anonymous');
    expect(guest.cache.size).toBe(0);
    employee.cache.set('2026-10', { schedules: [{ name: 'late old response' }], fetchedAt: 2 });
    expect(guest.cache.size).toBe(0);
    expect(select('signed-person-2').cache.size).toBe(0);
  });

  it('deduplicates ordinary reads for the same identity but keeps forced refresh independent', async () => {
    let resolve!: (value: unknown) => void;
    const read = jest.fn().mockImplementation(() => new Promise(done => { resolve = done; }));
    const select = factory()(read), scope = select('signed-person-1');
    expect(select('signed-person-1')).toBe(scope);
    const first = scope.read(2026, 10), second = scope.read(2026, 10);
    expect(first).toBe(second); expect(read).toHaveBeenCalledTimes(1);
    resolve({ schedules: [] }); await first; expect(scope.inFlight.size).toBe(0);
    const forced = scope.read(2026, 10, true);
    expect(read).toHaveBeenLastCalledWith(2026, 10, true);
    resolve({ schedules: [] }); await forced;
  });
});
