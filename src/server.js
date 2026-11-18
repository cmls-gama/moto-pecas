import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { z, ZodError } from 'zod';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { createDatabase } from './database.js';
import { ApiError, hashPassword, publicUser, verifyPassword } from './security.js';
import { createShop, publicOrder } from './shop.js';

z.config(z.locales.ptBR());

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const sessionSecret = process.env.SESSION_SECRET ?? randomBytes(48).toString('hex');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT deve ser uma porta válida.');
if (sessionSecret.length < 32) throw new Error('SESSION_SECRET deve conter pelo menos 32 caracteres.');

console.log('Iniciando MongoDB temporário. A primeira execução pode baixar o binário do MongoDB.');
const database = await createDatabase();
const { db } = database;
const shop = createShop(database);
const dummyHash = await hashPassword(randomBytes(32).toString('hex'));
const specFile = `${root}openapi.yaml`;
const specification = YAML.parse(await readFile(specFile, 'utf8'));
const app = express();
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
  strictTransportSecurity: false,
}));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) return next(new ApiError(403, 'INVALID_ORIGIN', 'Origem da requisição não permitida.'));
    if (!req.is('application/json')) return next(new ApiError(415, 'JSON_REQUIRED', 'Envie o corpo como application/json.'));
  }
  next();
});
app.use(express.json({ limit: '16kb' }));
app.use(session({
  name: 'moto.sid', secret: sessionSecret, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 2 * 60 * 60 * 1000 },
}));

const authLimit = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' } },
});
const emailSchema = z.string().trim().max(254).email('Informe um e-mail válido.').transform(value => value.toLowerCase());
const passwordSchema = z.string().min(8, 'A senha deve ter ao menos 8 caracteres.').max(128, 'A senha deve ter até 128 caracteres.');
const loginSchema = z.object({ email: emailSchema, password: passwordSchema }).strict();
const registerSchema = loginSchema.extend({ name: z.string().trim().min(2, 'Informe seu nome.').max(100) }).strict();
const quantitySchema = z.number().int().min(1).max(99);
const productIdSchema = z.string().min(1).max(80).regex(/^[a-z0-9-]+$/);
const states = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
const checkoutSchema = z.object({
  paymentMethod: z.enum(['cash', 'card']),
  address: z.object({
    recipient: z.string().trim().min(2).max(100),
    zipCode: z.string().trim().regex(/^\d{5}-?\d{3}$/, 'Informe um CEP válido.'),
    street: z.string().trim().min(2).max(150),
    number: z.string().trim().min(1).max(20),
    complement: z.string().trim().max(100).optional().default(''),
    city: z.string().trim().min(2).max(100),
    state: z.enum(states),
  }).strict(),
}).strict();

async function authenticate(req, res, next) {
  if (!req.session.userId) throw new ApiError(401, 'UNAUTHENTICATED', 'Entre na sua conta para continuar.');
  req.user = await shop.getUser(req.session.userId);
  next();
}
async function establishSession(req, userId) {
  await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
  req.session.userId = userId;
  await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
}

app.get('/api/health', (req, res) => res.json({ status: 'ok', database: 'in-memory' }));
app.get('/api/products', async (req, res) => {
  const products = await db.collection('products').find().toArray();
  res.json({ products: products.map(({ _id, ...product }) => ({ id: _id, ...product })) });
});
app.post('/api/auth/register', authLimit, async (req, res) => {
  const input = registerSchema.parse(req.body);
  const user = { _id: randomUUID(), name: input.name, email: input.email, passwordHash: await hashPassword(input.password), totalSpentCents: 0, cart: [], createdAt: new Date() };
  await db.collection('users').insertOne(user);
  await establishSession(req, user._id);
  res.status(201).json({ user: publicUser(user) });
});
app.post('/api/auth/login', authLimit, async (req, res) => {
  const input = loginSchema.parse(req.body);
  const user = await db.collection('users').findOne({ email: input.email });
  const valid = await verifyPassword(input.password, user?.passwordHash ?? dummyHash);
  if (!user || !valid) throw new ApiError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');
  await establishSession(req, user._id);
  res.json({ user: publicUser(user) });
});
app.get('/api/auth/me', authenticate, (req, res) => res.json({ user: publicUser(req.user) }));
app.post('/api/auth/logout', async (req, res) => {
  await new Promise((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve()));
  res.clearCookie('moto.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true' }).status(204).end();
});
app.get('/api/cart', authenticate, async (req, res) => res.json(await shop.cartView(req.user)));
app.post('/api/cart/items', authenticate, async (req, res) => {
  const { productId, quantity } = z.object({ productId: productIdSchema, quantity: quantitySchema }).strict().parse(req.body);
  res.status(201).json(await shop.changeCart(req.user._id, productId, quantity, 'add'));
});
app.patch('/api/cart/items/:productId', authenticate, async (req, res) => {
  const productId = productIdSchema.parse(req.params.productId);
  const { quantity } = z.object({ quantity: quantitySchema }).strict().parse(req.body);
  res.json(await shop.changeCart(req.user._id, productId, quantity, 'set'));
});
app.delete('/api/cart/items/:productId', authenticate, async (req, res) => {
  res.json(await shop.changeCart(req.user._id, productIdSchema.parse(req.params.productId), 0, 'remove'));
});
app.post('/api/checkout', authenticate, async (req, res) => {
  const input = checkoutSchema.parse(req.body);
  const key = z.string().uuid('Envie um UUID no cabeçalho Idempotency-Key.').parse(req.get('Idempotency-Key'));
  res.status(201).json(await shop.checkout(req.user._id, input, key));
});
app.get('/api/orders/:orderId', authenticate, async (req, res) => {
  const id = z.string().uuid().parse(req.params.orderId);
  const order = await db.collection('orders').findOne({ _id: id, userId: req.user._id });
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Pedido não encontrado.');
  res.json({ order: publicOrder(order) });
});

app.get('/api-docs.yaml', (req, res) => res.type('application/yaml').sendFile(specFile));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(specification, { customSiteTitle: 'Moto Peças | API', swaggerOptions: { url: '/api-docs.yaml', persistAuthorization: false } }));
app.use(express.static(`${root}public`, { index: 'index.html' }));
app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof ZodError) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Revise os dados informados.', details: error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) } });
  if (error.code === 11000) return res.status(409).json({ error: { code: 'CONFLICT', message: 'Este e-mail já está cadastrado ou a operação já foi processada.' } });
  if (error instanceof ApiError) return res.status(error.status).json({ error: { code: error.code, message: error.message } });
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'O corpo deve conter JSON válido.' } });
  if (error.type === 'entity.too.large') return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'O corpo da requisição excede o limite de 16 KB.' } });
  console.error('Falha interna:', error.message);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Não foi possível concluir a operação. Tente novamente.' } });
});

const server = app.listen(port, host, () => {
  console.log(`Site: http://${host}:${port}`);
  console.log(`Swagger: http://${host}:${port}/docs`);
  console.log('Dados temporários: serão recriados ao reiniciar a aplicação.');
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.closeIdleConnections();
  await new Promise(resolve => server.close(resolve));
  await database.close();
}
process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));
server.on('error', async error => { console.error(`Não foi possível iniciar: ${error.message}`); await database.close(); process.exit(1); });
