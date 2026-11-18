import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './security.js';

export async function createDatabase() {
  const memory = await MongoMemoryReplSet.create({
    binary: { downloadDir: fileURLToPath(new URL('../.cache/mongodb/', import.meta.url)) },
    replSet: { count: 1, storageEngine: 'wiredTiger', ip: '127.0.0.1' },
    instanceOpts: [{ args: ['--wiredTigerCacheSizeGB', '0.25'] }],
  });
  const client = new MongoClient(memory.getUri(), { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const db = client.db('moto_pecas');
    await db.collection('users').createIndex({ email: 1 }, { unique: true });
    await db.collection('orders').createIndex({ userId: 1, createdAt: -1 });
    await db.collection('orders').createIndex({ userId: 1, idempotencyKey: 1 }, { unique: true });
    await seed(db);
    return {
      client, db,
      async close() { await client.close(); await memory.stop(); },
    };
  } catch (error) {
    await client.close();
    await memory.stop();
    throw error;
  }
}

async function seed(db) {
  await db.collection('products').insertMany([
    {
      _id: 'kit-relacao', name: 'Kit de relação', category: 'TRANSMISSÃO',
      description: 'Corrente, coroa e pinhão. Conjunto para Honda CG 160.',
      priceCents: 18990, stock: 8, image: '/images/kit-relacao.svg', tag: 'ESSENCIAL',
    },
    {
      _id: 'disco-freio', name: 'Disco de freio dianteiro', category: 'FREIOS',
      description: 'Frenagem precisa para o dia a dia. Honda CG 160.',
      priceCents: 12990, stock: 3, image: '/images/disco-freio.svg', tag: 'MAIS CONTROLE',
    },
    {
      _id: 'filtro-oleo', name: 'Filtro de óleo', category: 'MOTOR',
      description: 'Proteção para o motor da sua Yamaha Fazer 250.',
      priceCents: 4990, stock: 0, image: '/images/filtro-oleo.svg', tag: 'MANUTENÇÃO',
    },
  ]);
  const passwordHash = await hashPassword('Moto@123');
  const users = [
    { _id: randomUUID(), name: 'Ana Silva', email: 'ana@motopecas.com', totalSpentCents: 0 },
    { _id: randomUUID(), name: 'Bruno Santos', email: 'bruno@motopecas.com', totalSpentCents: 25000 },
    { _id: randomUUID(), name: 'Carla Oliveira', email: 'carla@motopecas.com', totalSpentCents: 35000 },
  ];
  await db.collection('users').insertMany(users.map(user => ({ ...user, passwordHash, cart: [], createdAt: new Date() })));
  // Compras históricas demonstram a origem do acumulado; o estoque inicial já é o saldo atual.
  for (const user of users.filter(item => item.totalSpentCents > 0)) {
    await db.collection('orders').insertOne({
      _id: randomUUID(), userId: user._id, idempotencyKey: `seed-${user._id}`,
      number: `HIST-${user.name.split(' ')[0].toUpperCase()}`,
      items: [{ productId: 'kit-relacao', name: 'Kit de relação (preço histórico)', quantity: 1, unitPriceCents: user.totalSpentCents, lineTotalCents: user.totalSpentCents }],
      paymentMethod: 'card', subtotalCents: user.totalSpentCents, discountCents: 0,
      shippingCents: 2000, totalCents: user.totalSpentCents + 2000,
      wasVip: false, becameVip: user.totalSpentCents >= 30000,
      createdAt: new Date('2026-01-01T12:00:00Z'),
      address: { recipient: user.name, zipCode: '01001-000', street: 'Praça da Sé', number: '100', complement: '', city: 'São Paulo', state: 'SP' },
    });
  }
}
