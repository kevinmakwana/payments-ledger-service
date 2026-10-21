import { lookbackDates } from './reconciliation.processor';

describe('lookbackDates', () => {
  const now = Date.parse('2026-03-12T03:00:00Z');
  it('lists the days ending yesterday, oldest first', () => {
    expect(lookbackDates(3, now)).toEqual(['2026-03-09', '2026-03-10', '2026-03-11']);
    expect(lookbackDates(1, now)).toEqual(['2026-03-11']);
  });
  it('crosses month boundaries', () => {
    expect(lookbackDates(2, Date.parse('2026-03-01T03:00:00Z'))).toEqual(['2026-02-27', '2026-02-28']);
  });
});
