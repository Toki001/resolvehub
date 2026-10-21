export type TicketStatus = 'open' | 'pending' | 'resolved';
export type TicketEvent = 'create' | 'wait' | 'resolve' | 'reopen';

// Repeated commands converge on the same state; creation cannot reset a ticket.
export function ticketStatus(current: TicketStatus | null, event: TicketEvent): TicketStatus {
  if (current === null) {
    if (event !== 'create') throw new Error('Ticket must be created first');
    return 'open';
  }
  if (event === 'create') throw new Error('Ticket already exists');
  if (event === 'resolve') return 'resolved';
  if (event === 'reopen') return 'open';
  if (current === 'resolved') throw new Error('Resolved ticket must be reopened first');
  return 'pending';
}
