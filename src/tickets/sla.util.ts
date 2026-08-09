import { TicketPriority } from '@prisma/client';

// Demo delays (seconds) so the SLA job is observable without waiting hours.
// In a real policy these would be minutes/hours defined by the support contract.
const SLA_DELAY_SECONDS: Record<TicketPriority, number> = {
  CRITICAL: 15,
  HIGH: 30,
  MEDIUM: 60,
  LOW: 120,
};

export function slaDelayMs(priority: TicketPriority): number {
  return SLA_DELAY_SECONDS[priority] * 1000;
}
