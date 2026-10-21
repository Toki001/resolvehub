import { ticketStatus } from '../../packages/db/src/ticket-status.js';
import type { TicketStatus, TicketEvent } from '../../packages/db/src/ticket-status.js';

const cases: ReadonlyArray<readonly [TicketStatus | null, TicketEvent, TicketStatus | 'invalid']> =
  [
    [null, 'create', 'open'],
    [null, 'wait', 'invalid'],
    [null, 'resolve', 'invalid'],
    [null, 'reopen', 'invalid'],
    ['open', 'create', 'invalid'],
    ['open', 'wait', 'pending'],
    ['open', 'resolve', 'resolved'],
    ['open', 'reopen', 'open'],
    ['pending', 'create', 'invalid'],
    ['pending', 'wait', 'pending'],
    ['pending', 'resolve', 'resolved'],
    ['pending', 'reopen', 'open'],
    ['resolved', 'create', 'invalid'],
    ['resolved', 'wait', 'invalid'],
    ['resolved', 'resolve', 'resolved'],
    ['resolved', 'reopen', 'open'],
  ];
test.each(cases)('%s + %s deterministically produces %s', (current, event, expected) => {
  for (let replay = 0; replay < 2; replay++) {
    if (expected === 'invalid') expect(() => ticketStatus(current, event)).toThrow();
    else expect(ticketStatus(current, event)).toBe(expected);
  }
});
test('repeated non-creation commands converge without depending on a clock or random state', () => {
  const pending = ticketStatus('open', 'wait');
  expect(ticketStatus(pending, 'wait')).toBe(pending);
  const resolved = ticketStatus(pending, 'resolve');
  expect(ticketStatus(resolved, 'resolve')).toBe(resolved);
  const open = ticketStatus(resolved, 'reopen');
  expect(ticketStatus(open, 'reopen')).toBe(open);
});
