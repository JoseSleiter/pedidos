import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { isUniqueViolation, PrismaService, Tx } from '../../prisma/prisma.service';

export interface IdempotentResult<T> {
  /** true si NO se ejecutó el handler y se devolvió la respuesta guardada. */
  replayed: boolean;
  body: T;
}

/** Error interno para distinguir "la key ya existe" de cualquier otro P2002 dentro del handler. */
class DuplicateIdempotencyKey extends Error {}

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ejecuta `handler` como máximo una vez por (scope, key).
   *
   * Cómo funciona:
   * 1. Abre una transacción e INSERTA el registro de idempotencia como primera operación.
   * 2. Si llega una segunda request con la misma key mientras la primera sigue en curso,
   *    Postgres BLOQUEA su INSERT (índice único) hasta que la primera confirme o haga rollback:
   *      - si la primera confirmó → la segunda recibe P2002 y devuelve la respuesta guardada.
   *      - si la primera falló (rollback) → la segunda inserta y ejecuta normalmente.
   * 3. El handler y el guardado de la respuesta van en la MISMA transacción: o queda todo
   *    (pedido + respuesta) o no queda nada. Nunca un pedido creado sin respuesta guardada.
   */
  async execute<T>(
    scope: string,
    key: string,
    requestBody: unknown,
    handler: (tx: Tx) => Promise<T>,
  ): Promise<IdempotentResult<T>> {
    const requestHash = hashBody(requestBody);
// 'dd2b1427a9124f93b06cb83ec5200b439c6f79864ca8a0ebd0a59a37f29e2fe8'
    try {
      const body = await this.prisma.$transaction(
        async (tx) => {
          await tx.idempotencyRecord
            .create({ data: { scope, key, requestHash } })
            .catch((e) => {
              if (isUniqueViolation(e)) throw new DuplicateIdempotencyKey();
              throw e;
            });

          const result = await handler(tx);

          // Se guarda tal como se serializaría a JSON (las fechas quedan como string ISO).
          const serializable = JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue;
          await tx.idempotencyRecord.update({
            where: { scope_key: { scope, key } },
            data: { responseStatus: 201, responseBody: serializable },
          });

          return result;
        },
        { timeout: 10_000 },
      );

      return { replayed: false, body };
    } catch (e) {
      if (!(e instanceof DuplicateIdempotencyKey)) throw e;
      return this.replay<T>(scope, key, requestHash);
    }
  }

  private async replay<T>(scope: string, key: string, requestHash: string): Promise<IdempotentResult<T>> {
    const existing = await this.prisma.idempotencyRecord.findUniqueOrThrow({
      where: { scope_key: { scope, key } },
    });

    // Misma key con otro body = el cliente reutilizó mal la key. No adivinamos: error explícito.
    if (existing.requestHash !== requestHash) {
      throw new UnprocessableEntityException(
        'Idempotency-Key ya fue usada con un body distinto. Genera una key nueva para un pedido nuevo.',
      );
    }

    return { replayed: true, body: existing.responseBody as T };
  }
}

/** sha256 de un JSON "canónico" (claves ordenadas), para que {a,b} y {b,a} den el mismo hash. */
function hashBody(body: unknown): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${entries.join(',')}}`;
}
