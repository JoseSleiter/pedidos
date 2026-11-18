import { ConflictException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';

/**
 * Máquina de estados del pedido: la ÚNICA fuente de verdad sobre qué transiciones son válidas.
 * Si un cambio de estado no está aquí, no puede ocurrir.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING_PAYMENT: ['PAID', 'PAYMENT_FAILED', 'CANCELLED', 'EXPIRED'],
  PAYMENT_FAILED: ['PENDING_PAYMENT', 'CANCELLED', 'EXPIRED'], // puede reintentar el pago
  PAID: ['READY_TO_SHIP', 'REFUNDED'],
  READY_TO_SHIP: ['SHIPPED', 'REFUNDED'],
  SHIPPED: ['DELIVERED', 'DELIVERY_FAILED'],
  DELIVERY_FAILED: ['SHIPPED', 'REFUNDED'], // reintento de entrega
  DELIVERED: [],
  CANCELLED: [],
  EXPIRED: [],
  REFUNDED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictException(`Transición inválida: ${from} → ${to}`);
  }
}

/** Estados desde los que el stock reservado debe devolverse si el pedido se cierra. */
export const STOCK_RESERVED_STATES: readonly OrderStatus[] = ['PENDING_PAYMENT', 'PAYMENT_FAILED'];
