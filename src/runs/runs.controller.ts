import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { formatEnvError } from '../config/env.schema';
import { RunsService } from './runs.service';

const createRunBody = z
  .object({
    collections: z.array(z.string().min(1)).max(10).optional(),
    limitPerCollection: z.number().int().positive().max(1_000_000).optional(),
  })
  .strict();

const runId = z.string().uuid();

const errorQuery = z.object({
  page: z.preprocess((value) => (value === undefined || value === '' ? 1 : value), z.coerce.number().int().min(1).max(10_000)),
  limit: z.preprocess((value) => (value === undefined || value === '' ? 20 : value), z.coerce.number().int().min(1).max(100)),
});

@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  start(@Body() body: unknown) {
    const parsed = createRunBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(formatEnvError(parsed.error));
    return this.runs.start(parsed.data);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    const parsed = runId.safeParse(id);
    if (!parsed.success) throw new BadRequestException('run id must be a uuid');
    return this.runs.get(parsed.data);
  }

  @Get(':id/errors')
  errors(@Param('id') id: string, @Query() query: Record<string, unknown>) {
    const parsedId = runId.safeParse(id);
    if (!parsedId.success) throw new BadRequestException('run id must be a uuid');
    const parsedQuery = errorQuery.safeParse(query);
    if (!parsedQuery.success) throw new BadRequestException(formatEnvError(parsedQuery.error));
    return this.runs.errors(parsedId.data, parsedQuery.data.page, parsedQuery.data.limit);
  }
}
