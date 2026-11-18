import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IdempotencyKey } from '../common/idempotency/idempotency-key.decorator';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * POST /orders  (header obligatorio: Idempotency-Key: <uuid>)
   * - Primera vez con esa key → crea el pedido (201).
   * - Misma key + mismo body → devuelve el MISMO pedido (201) con header Idempotent-Replayed: true.
   * - Misma key + otro body → 422.
   */
  @Post()
  async create(
    @IdempotencyKey() key: string,
    @Body() dto: CreateOrderDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { replayed, body } = await this.idempotency.execute('POST /orders', key, dto, (tx) =>
      this.orders.create(tx, dto),
    );
    res.setHeader('Idempotent-Replayed', String(replayed));
    return body;
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.findOne(id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.cancel(id);
  }
}
