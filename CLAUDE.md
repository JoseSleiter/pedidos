# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es este proyecto

Proyecto de práctica (NestJS 11 + Prisma 6 + Postgres) de un sistema de pedidos con pago Webpay y
despacho. El objetivo no es la funcionalidad, es practicar **idempotencia, máquinas de estado y
reintentos**. Avanza por fases; solo la **fase 1 está implementada** (pedidos, reserva de stock,
idempotencia). Fases 2-5 (Webpay, outbox + BullMQ, conciliación por cron, frontend React) están en el
esquema de Prisma y en los comentarios `// fase N`, pero sin código todavía.

El código, los comentarios y los mensajes de error están **en español**. Mantener ese idioma.

## Comandos

Todo se ejecuta desde `backend/`, salvo docker compose que va en la raíz.

```bash
nvm use                              # OBLIGATORIO: v24 (ver trampa 1 más abajo)
docker compose up -d                 # Postgres (5433) + Redis (6379), desde la raíz

cd backend
npm install
npx prisma migrate dev               # aplica migraciones pendientes y regenera el cliente
npm run db:seed                      # 3 productos con IDs fijos (ver README)
npm run start:dev                    # API en http://localhost:3000, con watch

npm run build                        # nest build
npm run prisma:generate              # solo regenerar el cliente tras tocar schema.prisma
npx prisma migrate status            # ver si faltan migraciones
npx prisma studio                    # inspeccionar datos
```

No hay **lint ni tests configurados**: no existe eslint, prettier, jest ni script `test`. No afirmar que
algo "pasa los tests"; la verificación de la fase 1 es manual con los `curl` del README. Si se piden
tests, hay que instalar y configurar Jest + supertest primero.

## Dos trampas del entorno (causan casi todos los fallos aquí)

**1. Node por defecto es v16, el proyecto necesita v24.** `.nvmrc` fija `v24.19.0`, pero el shell suele
arrancar con v16.16.0. Prisma 6 exige Node >= 18.18 y NestJS 11 pide >= 20. Con Node 16 el CLI de Prisma
**no avisa de la versión**: explota volcando su bundle minificado, cientos de KB de JavaScript ilegible,
y es fácil confundir eso con que el comando esté mal o deprecado. Antes de cualquier comando de npm o
prisma:

```bash
node -v        # si no es v24.x, el comando va a fallar de forma confusa
nvm use        # lee .nvmrc
```

**2. Este proyecto usa el puerto 5433, no el 5432.** En esta máquina el 5432 lo ocupa `campus-postgres`
(de otro proyecto), así que el Postgres de aquí está mapeado a `"5433:5432"` en `docker-compose.yml` y
`DATABASE_URL` apunta a `localhost:5433`. **No volver a poner 5432**: el contenedor se queda en estado
`Created` sin arrancar y las queries se van a la base equivocada → `P1000: Authentication failed ...
credentials for 'app' are not valid`. Un `P1000` aquí casi nunca es la contraseña: es que estás hablando
con otro Postgres. Comprobar con `docker ps --format '{{.Names}}\t{{.Ports}}'`.

## Prisma: qué está deprecado y qué no

- `prisma migrate dev` **no está obsoleto**, es el comando correcto en Prisma 6 y sigue existiendo en 7.
- El warning real que aparece es otro:
  `The configuration property 'package.json#prisma' is deprecated and will be removed in Prisma 7`.
  Se refiere **solo** al bloque `"prisma": { "seed": ... }` de `backend/package.json`, que en Prisma 7 se
  mueve a un `prisma.config.ts`. Lo emite únicamente `db:seed` (es el único comando que lee esa
  propiedad), no `migrate dev`. Es un aviso, no un error: el comando funciona igual.
- **Prisma 6 está pinneado a propósito** (ver README): Prisma 7 cambia la configuración (adapters,
  `prisma.config.ts`) y para practicar estos conceptos da lo mismo. No subir de versión ni migrar a
  `prisma.config.ts` para silenciar el warning sin pedirlo antes.
- La migración inicial ya está creada y aplicada (`prisma/migrations/20261028043956_init/`).

## Arquitectura

Backend NestJS modular en `backend/src`. `PrismaModule` e `IdempotencyModule` son `@Global()`, así que
`PrismaService` e `IdempotencyService` se inyectan sin importarlos. `PrismaService` extiende
`PrismaClient` y engancha `$connect`/`$disconnect` al ciclo de vida de Nest.

Las cuatro ideas que hay que entender antes de tocar nada:

**Idempotencia por índice único, no por caché** (`common/idempotency/idempotency.service.ts`).
`IdempotencyService.execute(scope, key, body, handler)` abre una transacción y el **primer** statement es
el `INSERT` en `IdempotencyRecord`, que tiene `@@unique([scope, key])`. Si llega una segunda request con
la misma key mientras la primera está en curso, Postgres **bloquea** su INSERT hasta que la primera
commitee (→ la segunda recibe P2002 y devuelve la respuesta guardada) o haga rollback (→ la segunda
ejecuta normalmente). El handler y el guardado de la respuesta van en la **misma** transacción: nunca
queda un pedido creado sin su respuesta guardada. Misma key con otro body (hash sha256 de un JSON
canónico con claves ordenadas) → 422. Timeout de la transacción: 10 s.

**Los errores no se persisten, a propósito.** Si el handler falla, el rollback borra también el registro
de la key, así que el cliente puede reintentar con la misma key. Es una decisión de diseño discutida en el
README (Stripe hace lo contrario); no "arreglarla" sin hablarlo.

**El `Tx` se pasa a mano.** `PrismaService` exporta `type Tx = Prisma.TransactionClient`. Los métodos que
corren dentro de una transacción ajena reciben `tx` como primer parámetro
(`OrdersService.create(tx, dto)`, `transition(tx, ...)`) y **nunca** usan `this.prisma` directamente —
hacerlo sacaría la query de la transacción y rompería la atomicidad. Al añadir pagos o despacho, seguir
este patrón.

**Máquina de estados + compare-and-set** (`orders/order-state.ts`, `OrdersService.transition`).
`ORDER_TRANSITIONS` es la única fuente de verdad de qué transiciones existen; lo que no está ahí no puede
pasar. `transition()` valida contra el mapa y luego hace `UPDATE ... WHERE id = ? AND status = from`: si
otra request cambió el estado entre medio, `count === 0` y lanza 409. Nunca cambiar `status` con un
`update` directo, siempre por `transition()`.

**Reserva de stock atómica** (`OrdersService.create`). `UPDATE products SET stock = stock - n WHERE id = ?
AND stock >= n`, y si `count === 0` → 409 por stock insuficiente. No hay "leer, validar, escribir", así
que dos compras simultáneas de la última unidad no pueden ganar las dos. Los items duplicados se fusionan
y se ordenan por id antes de reservar, para que transacciones concurrentes bloqueen los productos en el
mismo orden y no haya deadlocks. El stock se reserva **al crear el pedido**, no al pagar; de ahí
`paymentDeadline` y el cron de expiración de la fase 4.

### Reglas de dominio que ya están codificadas

- Los precios y el total **los calcula el servidor** desde la base de datos. El cliente solo manda
  `productId` y `quantity`; el DTO rechaza cualquier campo extra (`forbidNonWhitelisted`, 400).
- `unitPrice` en `OrderItem` congela el precio del momento de la compra.
- Montos en **enteros** (CLP sin decimales), porque Webpay trabaja así. Nunca float.
- El header `Idempotency-Key` debe ser un **UUID** (`IdempotencyKey` decorator, 400 si no). La respuesta
  lleva `Idempotent-Replayed: true|false`.
- El esquema usa restricciones `unique` como última línea de defensa: `Payment.buyOrder`, `Payment.token`,
  `@@unique([orderId, attempt])`, `Shipment.orderId` (máximo un despacho por pedido),
  `@@unique([source, eventId])` en `ProcessedWebhook` para deduplicar webhooks del courier.

## Notas

- `backend/.env` ya existe y está sincronizado con `.env.example` (ambos en el 5433).
- Las 4 pruebas manuales del README (replay, key con otro body → 422, carrera por la última unidad →
  201+409) se verificaron funcionando contra esta base.
- El repositorio **no está bajo git** todavía (no hay `.git`). No asumir comandos de git ni ramas.
- El Redis del compose es para la fase 3 (BullMQ); hoy no se usa.
