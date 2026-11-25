import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { ObjectId } from 'mongodb';
import { HttpError, requireValue, objectId, quantity, credentials, hashPassword, verifyPassword, publicUser, publicProduct, paymentMethod, cartView } from './domain.js';

const publicPath = fileURLToPath(new URL('../public', import.meta.url));
const specPath = fileURLToPath(new URL('../docs/openapi.yaml', import.meta.url));
const regenerate = req => new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
const saveSession = req => new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));

export function createApp({ db, client }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { 'script-src': ["'self'"], 'style-src': ["'self'", "'unsafe-inline'"], 'img-src': ["'self'", 'data:'], 'upgrade-insecure-requests': null } } }));
  app.use(express.json({ limit: '16kb' }));
  app.use(session({ name: 'giro.sid', secret: process.env.SESSION_SECRET || randomBytes(48).toString('hex'), resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'strict', secure: false, maxAge: 8 * 60 * 60 * 1000 } }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('Origin');
      if (origin && origin !== `${req.protocol}://${req.get('host')}`) return next(new HttpError(403, 'Origem da requisição não permitida.'));
      if (['POST', 'PATCH'].includes(req.method) && !req.is('application/json')) return next(new HttpError(415, 'Envie o corpo como application/json.'));
    }
    next();
  });
  const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Muitas tentativas. Tente novamente em 15 minutos.' } });
  const users = db.collection('users');
  const products = db.collection('products');
  const orders = db.collection('orders');
  const authenticate = async (req, res, next) => {
    if (!req.session.userId) throw new HttpError(401, 'Entre na sua conta para continuar.');
    req.user = await users.findOne({ _id: objectId(req.session.userId) });
    if (!req.user) throw new HttpError(401, 'Sessão inválida. Entre novamente.');
    next();
  };
  const transaction = work => client.withSession(session => session.withTransaction(() => work(session)));

  app.get('/api/health', async (req, res) => { await db.command({ ping: 1 }); res.json({ status: 'ok', database: 'temporary' }); });
  app.get('/api/openapi.yaml', (req, res) => res.type('application/yaml').sendFile(specPath));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(parse(readFileSync(specPath, 'utf8')), { customSiteTitle: 'GIRO | API REST', swaggerOptions: { persistAuthorization: false } }));

  app.post('/api/auth/register', authLimit, async (req, res) => {
    const data = credentials(req.body, true);
    const user = { _id: new ObjectId(), name: data.name, email: data.email, passwordHash: await hashPassword(data.password), totalSpentCents: 0, cart: [] };
    await users.insertOne(user);
    await regenerate(req);
    req.session.userId = user._id.toString();
    await saveSession(req);
    res.status(201).json({ user: publicUser(user) });
  });
  app.post('/api/auth/login', authLimit, async (req, res) => {
    const { email, password } = credentials(req.body);
    const user = await users.findOne({ email });
    // O hash substituto também executa scrypt quando o e-mail não existe.
    const fallback = '00000000000000000000000000000000:' + '00'.repeat(64);
    const matches = await verifyPassword(password, user?.passwordHash || fallback);
    requireValue(user && matches, 'E-mail ou senha inválidos.', 401);
    await regenerate(req);
    req.session.userId = user._id.toString();
    await saveSession(req);
    res.json({ user: publicUser(user) });
  });
  app.post('/api/auth/logout', async (req, res) => {
    await new Promise((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve()));
    res.clearCookie('giro.sid', { httpOnly: true, sameSite: 'strict', secure: false });
    res.status(204).end();
  });
  app.get('/api/auth/me', authenticate, (req, res) => res.json({ user: publicUser(req.user) }));
  app.get('/api/products', async (req, res) => res.json({ products: (await products.find().sort({ _id: 1 }).toArray()).map(publicProduct) }));

  app.get('/api/cart', authenticate, async (req, res) => res.json(await cartView(db, req.user)));
  async function changeCart(req, operation) {
    return transaction(async session => {
      const user = await users.findOne({ _id: req.user._id }, { session });
      await operation(user, session);
      await users.updateOne({ _id: user._id }, { $set: { cart: user.cart } }, { session });
      return cartView(db, user, 'card', session);
    });
  }
  app.post('/api/cart/items', authenticate, async (req, res) => {
    const id = objectId(req.body?.productId).toString();
    const amount = quantity(req.body?.quantity);
    const cart = await changeCart(req, async (user, session) => {
      const product = await products.findOne({ _id: objectId(id) }, { session });
      requireValue(product, 'Produto não encontrado.', 404);
      const existing = user.cart.find(item => item.productId === id);
      const nextQuantity = quantity((existing?.quantity || 0) + amount);
      requireValue(product.stock >= nextQuantity, 'Estoque insuficiente para a quantidade solicitada.', 409);
      if (existing) existing.quantity = nextQuantity;
      else user.cart.push({ productId: id, quantity: nextQuantity });
    });
    res.status(201).json(cart);
  });
  app.patch('/api/cart/items/:productId', authenticate, async (req, res) => {
    const id = objectId(req.params.productId).toString();
    const amount = quantity(req.body?.quantity);
    res.json(await changeCart(req, async (user, session) => {
      const item = user.cart.find(item => item.productId === id);
      requireValue(item, 'Produto não encontrado no carrinho.', 404);
      const product = await products.findOne({ _id: objectId(id) }, { session });
      requireValue(product && product.stock >= amount, 'Estoque insuficiente para a quantidade solicitada.', 409);
      item.quantity = amount;
    }));
  });
  app.delete('/api/cart/items/:productId', authenticate, async (req, res) => {
    const id = objectId(req.params.productId).toString();
    res.json(await changeCart(req, user => {
      requireValue(user.cart.some(item => item.productId === id), 'Produto não encontrado no carrinho.', 404);
      user.cart = user.cart.filter(item => item.productId !== id);
    }));
  });
  app.delete('/api/cart', authenticate, async (req, res) => res.json(await changeCart(req, user => { user.cart = []; })));
  app.post('/api/checkout/preview', authenticate, async (req, res) => res.json(await cartView(db, req.user, paymentMethod(req.body?.paymentMethod))));
  app.post('/api/checkout', authenticate, async (req, res) => {
    const method = paymentMethod(req.body?.paymentMethod);
    const key = req.get('Idempotency-Key');
    requireValue(typeof key === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(key), 'Informe Idempotency-Key com 8 a 100 letras, números, hífens ou sublinhados.');
    const result = await transaction(async session => {
      const previous = await orders.findOne({ userId: req.user._id.toString(), idempotencyKey: key }, { session });
      if (previous) {
        requireValue(previous.paymentMethod === method, 'Esta chave já foi usada com outra forma de pagamento.', 409);
        return { order: previous, replayed: true };
      }
      const user = await users.findOne({ _id: req.user._id }, { session });
      const cart = await cartView(db, user, method, session);
      requireValue(cart.items.length, 'Seu carrinho está vazio.', 409);
      requireValue(cart.canCheckout, 'O estoque mudou. Ajuste as quantidades do carrinho.', 409);
      for (const item of cart.items) {
        const updated = await products.updateOne({ _id: objectId(item.product.id), stock: { $gte: item.quantity } }, { $inc: { stock: -item.quantity } }, { session });
        requireValue(updated.modifiedCount === 1, 'O estoque mudou. Ajuste as quantidades do carrinho.', 409);
      }
      // Só produtos efetivamente pagos contam para VIP; o frete não acumula.
      user.totalSpentCents += cart.subtotalCents - cart.discountCents;
      const order = { _id: new ObjectId(), userId: user._id.toString(), idempotencyKey: key, createdAt: new Date().toISOString(), ...cart, user: publicUser(user), status: 'confirmed' };
      await orders.insertOne(order, { session });
      await users.updateOne({ _id: user._id }, { $set: { cart: [], totalSpentCents: user.totalSpentCents } }, { session });
      return { order, replayed: false };
    });
    res.status(result.replayed ? 200 : 201).location(`/api/orders/${result.order._id}`).json({ order: serializeOrder(result.order), replayed: result.replayed });
  });
  app.get('/api/orders/:id', authenticate, async (req, res) => {
    const order = await orders.findOne({ _id: objectId(req.params.id), userId: req.user._id.toString() });
    requireValue(order, 'Pedido não encontrado.', 404);
    res.json({ order: serializeOrder(order) });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint não encontrado.' }));
  app.use(express.static(publicPath));
  app.use((req, res) => res.status(404).type('text').send('Página não encontrada.'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.code === 11000) return res.status(409).json({ error: 'E-mail ou chave de compra já cadastrado.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Corpo da requisição muito grande.' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(error);
    res.status(status).json({ error: status === 500 ? 'Não foi possível concluir a operação.' : error.message });
  });
  return app;
}

function serializeOrder(order) {
  const { _id, userId, idempotencyKey, ...receipt } = order;
  return { id: _id.toString(), ...receipt };
}
