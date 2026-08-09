import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';

interface SlaJobData {
  ticketId: string;
}

const OPEN_STATUSES = new Set(['OPEN', 'IN_PROGRESS']);

@Processor('sla')
export class SlaProcessor extends WorkerHost {
  private readonly logger = new Logger(SlaProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<SlaJobData>) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: job.data.ticketId },
    });

    if (!ticket) return;

    if (OPEN_STATUSES.has(ticket.status)) {
      this.logger.warn(
        `SLA estourado: ticket ${ticket.id} (${ticket.priority}) segue "${ticket.status}"`,
      );
    } else {
      this.logger.log(
        `SLA cumprido: ticket ${ticket.id} foi resolvido a tempo`,
      );
    }
  }
}
