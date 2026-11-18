import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// IDs fijos para poder usarlos en los ejemplos de curl del README.
const products = [
  { id: '11111111-1111-4111-8111-111111111111', sku: 'POLERA-001', name: 'Polera básica', price: 9990, stock: 50 },
  { id: '22222222-2222-4222-8222-222222222222', sku: 'TAZA-001', name: 'Taza de cerámica', price: 5490, stock: 20 },
  { id: '33333333-3333-4333-8333-333333333333', sku: 'GORRO-001', name: 'Gorro (última unidad)', price: 12990, stock: 1 },
];

async function main() {
  for (const p of products) {
    await prisma.product.upsert({
      where: { id: p.id },
      update: { price: p.price, stock: p.stock, name: p.name },
      create: p,
    });
  }
  console.log(`Seed listo: ${products.length} productos`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
