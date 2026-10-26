import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { OperationsKbService } from '@server/modules/operations-kb/operations-kb.service';

@Controller('api/operations-kb')
export class OperationsKbController {
  constructor(private readonly operationsKbService: OperationsKbService) {}

  @Get('stats')
  async stats() {
    return this.operationsKbService.stats();
  }

  @Get('search')
  async search(
    @Query('q') query?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('module') module?: string,
    @Query('documentType') documentType?: string,
    @Query('specialty') specialty?: string,
    @Query('equipmentType') equipmentType?: string,
    @Query('scenario') scenario?: string,
    @Query('level') level?: string,
    @Query('sort') sort?: 'relevance' | 'latest',
  ) {
    return this.operationsKbService.search({
      query,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      sort: sort === 'latest' ? 'latest' : 'relevance',
      filters: {
        module,
        documentType,
        specialty,
        equipmentType,
        scenario,
        level,
      },
    });
  }

  @Get('documents/:id')
  async document(@Param('id') id: string) {
    const document = await this.operationsKbService.document(id);
    if (!document) {
      throw new NotFoundException('Operations knowledge base document not found');
    }
    return document;
  }
}
