# Pedidos + Webpay + Despacho (proyecto de práctica)

Proyecto para practicar, por fases, un sistema de pedidos con pago (Webpay) y despacho,
enfocado en **idempotencia, máquinas de estado y reintentos**.

| Fase | Contenido | Estado |
|---|---|---|
| 1 | Base NestJS + Prisma + Postgres, pedidos con `Idempotency-Key`, reserva de stock, máquina de estados | ✅ |
| 2 | Pagos Webpay Plus (integración): crear transacción, `return_url`, commit atómico | ⏳ |
| 3 | Outbox + BullMQ: creación de despacho con reintentos y webhooks del courier | ⏳ |
| 4 | Conciliación (cron): pagos `UNKNOWN`, pedidos expirados, pedidos pagados sin despacho | ⏳ |
| 5 | Frontend React: checkout y pantalla de resultado | ⏳ |

## Requisitos

- Node.js 20 o superior
- Docker (para Postgres y Redis)

## Puesta en marcha

```bash
# 1. Base de datos
docker compose up -d

# 2. Backend
cd backend
cp .env.example .env
npm install
npx prisma migrate dev --name init   # crea las tablas y genera el cliente
npm run db:seed                      # carga 3 productos de prueba
npm run start:dev
```

La API queda en `http://localhost:3000`.

> Usamos Prisma 6 a propósito: Prisma 7 cambió la configuración (adapters, `prisma.config.ts`)
> y para practicar los conceptos de este proyecto da lo mismo.

## Probar la fase 1

Productos de prueba (IDs fijos del seed):

| ID | Producto | Precio | Stock |
|---|---|---|---|
| `11111111-1111-4111-8111-111111111111` | Polera básica | 9.990 | 50 |
| `22222222-2222-4222-8222-222222222222` | Taza de cerámica | 5.490 | 20 |
| `33333333-3333-4333-8333-333333333333` | Gorro (última unidad) | 12.990 | 1 |

### 1. Crear un pedido

```bash
KEY=$(uuidgen)   # en Windows PowerShell: $KEY = [guid]::NewGuid()

curl -i -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $KEY" \
  -d '{
    "customerEmail": "ana@example.com",
    "shippingAddress": "Av. Siempre Viva 742, Santiago",
    "items": [{ "productId": "11111111-1111-4111-8111-111111111111", "quantity": 2 }]
  }'
```

Fíjate en el header `Idempotent-Replayed: false` y anota el `id` del pedido.

### 2. Repetir EXACTAMENTE la misma request (simula doble clic o reintento por red)

Vuelve a ejecutar el mismo comando con la misma `$KEY`.
Debes recibir **el mismo `id`** y `Idempotent-Replayed: true`. El stock de la polera no baja dos veces.

### 3. Misma key, otro body

Cambia `quantity` a 3 y repite con la misma `$KEY` → **422**.

### 4. Carrera por la última unidad

Ejecuta dos requests en paralelo, cada una con **su propia key**, pidiendo el gorro (stock 1):

```bash
for i in 1 2; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/orders \
    -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \
    -d '{"customerEmail":"a@b.cl","shippingAddress":"Calle 123, Stgo","items":[{"productId":"33333333-3333-4333-8333-333333333333","quantity":1}]}' &
done; wait
```

Resultado esperado: un `201` y un `409`.

### 5. Consultar y cancelar

```bash
curl http://localhost:3000/orders/<id>
curl -X POST http://localhost:3000/orders/<id>/cancel   # devuelve el stock
curl -X POST http://localhost:3000/orders/<id>/cancel   # segunda vez: OK, sin devolver stock de nuevo
```

## Dónde mirar en el código

| Concepto | Archivo |
|---|---|
| Idempotencia de requests (bloqueo por índice único + respuesta guardada) | `backend/src/common/idempotency/idempotency.service.ts` |
| Máquina de estados del pedido | `backend/src/orders/order-state.ts` |
| Transición con *compare-and-set* (`UPDATE ... WHERE status = from`) | `OrdersService.transition` |
| Reserva de stock atómica (`UPDATE ... WHERE stock >= qty`) | `OrdersService.create` |
| Restricciones `unique` como última defensa | `backend/prisma/schema.prisma` |

## Decisiones de diseño para discutir

- **Los errores no se guardan.** Si el pedido falla (por ejemplo, sin stock), la transacción hace rollback
  y el registro de la key desaparece, así que el cliente puede reintentar con la misma key.
  Otras APIs (como Stripe) sí guardan las respuestas 4xx. ¿Cuál prefieres y por qué?
- **El total lo calcula el servidor.** El front solo manda `productId` y `quantity`.
- **El stock se reserva al crear el pedido**, no al pagar. Por eso existe `paymentDeadline`:
  en la fase 4 un cron expira los pedidos no pagados y devuelve el stock.

## Ejercicios (antes de pasar a la fase 2)

1. Escribe un test e2e que mande dos `POST /orders` **simultáneos con la misma key** y verifique
   que se creó un solo pedido.
2. ¿Qué pasa si la segunda request espera más que el `timeout` de la transacción (10 s)?
   ¿Qué código HTTP debería recibir el cliente y qué debería hacer?
3. Las keys de idempotencia se acumulan para siempre. Diseña cómo limpiarlas
   (pista: `createdAt` + un cron, y decide cuántas horas guardarlas).
