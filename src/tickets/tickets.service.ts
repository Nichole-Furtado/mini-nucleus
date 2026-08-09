import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { InjectQueue } from '@nestjs/bullmq';
import type { Cache } from 'cache-manager';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { slaDelayMs } from './sla.util';

const LIST_CACHE_KEY = 'tickets:all';
const TTL_MS = 30_000;

@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    @InjectQueue('sla') private readonly slaQueue: Queue,
  ) {}

  async create(createTicketDto: CreateTicketDto) {
    const priority = createTicketDto.priority ?? 'MEDIUM';
    const delay = slaDelayMs(priority);

    const ticket = await this.prisma.ticket.create({
      data: { ...createTicketDto, slaDueAt: new Date(Date.now() + delay) },
    });

    await this.slaQueue.add(
      'check-sla',
      { ticketId: ticket.id },
      { delay },
    );
    await this.invalidateListCache();

    return ticket;
  }

  async findAll() {
    const cached = await this.cache.get(LIST_CACHE_KEY);
    if (cached) return cached;

    const tickets = await this.prisma.ticket.findMany({
      orderBy: { createdAt: 'desc' },
    });
    await this.cache.set(LIST_CACHE_KEY, tickets, TTL_MS);
    return tickets;
  }

  async findOne(id: string) {
    const cacheKey = this.entryCacheKey(id);
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    const ticket = await this.prisma.ticket.findUnique({ where: { id } });
    if (!ticket) {
      throw new NotFoundException(`Ticket ${id} não encontrado`);
    }
    await this.cache.set(cacheKey, ticket, TTL_MS);
    return ticket;
  }

  async update(id: string, updateTicketDto: UpdateTicketDto) {
    await this.findOne(id);
    const ticket = await this.prisma.ticket.update({
      where: { id },
      data: updateTicketDto,
    });
    await this.invalidateEntry(id);
    return ticket;
  }

  async remove(id: string) {
    await this.findOne(id);
    const ticket = await this.prisma.ticket.delete({ where: { id } });
    await this.invalidateEntry(id);
    return ticket;
  }

  private entryCacheKey(id: string) {
    return `tickets:${id}`;
  }

  private async invalidateListCache() {
    await this.cache.del(LIST_CACHE_KEY);
  }

  private async invalidateEntry(id: string) {
    await Promise.all([
      this.cache.del(this.entryCacheKey(id)),
      this.invalidateListCache(),
    ]);
  }
}
