import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { Request } from 'express';

/**
 * Lee y valida el header `Idempotency-Key`.
 * Exigimos un UUID para evitar keys triviales ("1", "test") que choquen entre clientes.
 */
export const IdempotencyKey = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<Request>();
  const key = req.header('idempotency-key');

  if (!key) throw new BadRequestException('Falta el header Idempotency-Key');
  if (!isUUID(key)) throw new BadRequestException('Idempotency-Key debe ser un UUID');

  return key;
});
