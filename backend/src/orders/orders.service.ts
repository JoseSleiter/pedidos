import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus } from '@prisma/client';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { CreateOrderDto, CreateOrderItemDto } from './dto/create-order.dto';
import { assertTransition, STOCK_RESERVED_STATES } from './order-state';

const ORDER_INCLUDE = {
  items: true,
  payments: { orderBy: { attempt: 'asc' as const } },
  shipment: true,
};

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Crea el pedido y reserva stock. Recibe `tx` porque se ejecuta DENTRO de la transacción
   * de idempotencia: si algo falla, se revierte el pedido, la reserva y el registro de la key.
   */
  async create(tx: Tx, dto: CreateOrderDto) {
    const items = mergeDuplicateItems(dto.items);

    const products = await tx.product.findMany({
      where: { id: { in: items.map((i) => i.productId) } },
    });
    if (products.length !== items.length) {
      throw new NotFoundException('Uno o más productos no existen');
    }
    const priceById = new Map(products.map((p) => [p.id, p.price]));

    // Reserva de stock con UPDATE condicional: "descuenta solo si alcanza".
    // Es atómico en la base de datos, así que dos compras simultáneas de la última unidad
    // no pueden ganar las dos (no hay "leer stock → validar → escribir" con carrera en medio).
    for (const item of items) {
      const reserved = await tx.product.updateMany({
        where: { id: item.productId, stock: { gte: item.quantity } },
        data: { stock: { decrement: item.quantity } },
      });
      if (reserved.count === 0) {
        throw new ConflictException(`Stock insuficiente para el producto ${item.productId}`);
      }
    }

    const total = items.reduce((sum, i) => sum + priceById.get(i.productId)! * i.quantity, 0);
    const deadlineMinutes = Number(this.config.get('PAYMENT_DEADLINE_MINUTES') ?? 15);

    return tx.order.create({
      data: {
        customerEmail: dto.customerEmail,
        shippingAddress: dto.shippingAddress,
        total,
        paymentDeadline: new Date(Date.now() + deadlineMinutes * 60_000),
        items: {
          create: items.map((i) => ({
            productId: i.productId,
            quantity: i.quantity,
            unitPrice: priceById.get(i.productId)!,
          })),
        },
      },
      include: ORDER_INCLUDE,
    });
  }

  async findOne(id: string) {
    const order = await this.prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
    if (!order) throw new NotFoundException('Pedido no encontrado');
    return order;
  }

  /** Cancela un pedido no pagado y devuelve el stock, todo en una transacción. */
  async cancel(id: string) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id }, include: { items: true } });
      if (!order) throw new NotFoundException('Pedido no encontrado');

      // Idempotente: cancelar algo ya cancelado responde OK sin volver a devolver stock.
      if (order.status === 'CANCELLED') return this.findOneTx(tx, id);

      await this.transition(tx, id, order.status, 'CANCELLED');

      if (STOCK_RESERVED_STATES.includes(order.status)) {
        for (const item of order.items) {
          await tx.product.update({
            where: { id: item.productId },
            data: { stock: { increment: item.quantity } },
          });
        }
      }

      return this.findOneTx(tx, id);
    });
  }

  /**
   * Cambio de estado seguro ante concurrencia ("compare-and-set"):
   * 1. Valida que la transición exista en la máquina de estados.
   * 2. Actualiza SOLO si el estado actual sigue siendo `from`.
   * Si otra request cambió el estado entre medio, count = 0 y lanzamos 409.
   * La usaremos también en pagos (fase 2) y despacho (fase 3).
   */
  async transition(tx: Tx, orderId: string, from: OrderStatus, to: OrderStatus) {
    assertTransition(from, to);
    const updated = await tx.order.updateMany({
      where: { id: orderId, status: from },
      data: { status: to },
    });
    if (updated.count === 0) {
      throw new ConflictException(`El pedido ya no está en estado ${from}`);
    }
  }

  private findOneTx(tx: Tx, id: string) {
    return tx.order.findUniqueOrThrow({ where: { id }, include: ORDER_INCLUDE });
  }
}

/** [{A,1},{A,2}] → [{A,3}] para no reservar el mismo producto dos veces por separado. */
function mergeDuplicateItems(items: CreateOrderItemDto[]): CreateOrderItemDto[] {
  const merged = new Map<string, number>();
  for (const i of items) merged.set(i.productId, (merged.get(i.productId) ?? 0) + i.quantity);
  // Orden estable por id: si dos transacciones bloquean los mismos productos,
  // los bloquean en el mismo orden y se evitan deadlocks.
  return [...merged.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([productId, quantity]) => ({ productId, quantity }));
}
