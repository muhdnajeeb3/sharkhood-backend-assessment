import { Injectable, NotFoundException } from '@nestjs/common';
import { QuarantineStore } from '../core/ports/quarantine-store';
import { RunStore } from '../core/ports/run-store';
import { RunDispatcher } from '../queue/dispatcher.service';
import { RunView } from './run.types';

@Injectable()
export class RunsService {
  constructor(
    private readonly dispatcher: RunDispatcher,
    private readonly runs: RunStore,
    private readonly quarantine: QuarantineStore,
  ) {}

  start(input: { collections?: string[]; limitPerCollection?: number }) {
    return this.dispatcher.start(input);
  }

  async get(id: string): Promise<RunView> {
    const run = await this.require(id);
    const end = run.finishedAt ?? new Date();
    return { ...run, durationMs: end.getTime() - run.startedAt.getTime() };
  }

  async errors(id: string, page: number, limit: number) {
    await this.require(id);
    const result = await this.quarantine.list(id, (page - 1) * limit, limit);
    return { runId: id, page, limit, total: result.total, errors: result.errors };
  }

  private async require(id: string) {
    const run = await this.runs.get(id);
    if (!run) throw new NotFoundException(`Run ${id} not found`);
    return run;
  }
}
