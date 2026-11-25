import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ObjectId } from 'mongodb';

const scrypt = promisify(scryptCallback);
export const VIP_THRESHOLD_CENTS = 30000;
export const SHIPPING_CENTS = 2000;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function requireValue(condition, message, status = 400) {
  if (!condition) throw new HttpError(status, message);
}
export function objectId(value) {
  requireValue(typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value), 'Identificador inválido.');
  return new ObjectId(value);
}
export function quantity(value) {
  requireValue(Number.isInteger(value) && value >= 1 && value <= 999, 'A quantidade deve ser um inteiro entre 1 e 999.');
  return value;
}
export function credentials(body, registration = false) {
  const { email, password, name } = body ?? {};
  requireValue(typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()), 'Informe um e-mail válido.');
  requireValue(typeof password === 'string' && password.length >= 8 && password.length <= 72, 'A senha deve ter entre 8 e 72 caracteres.');
  if (registration) requireValue(typeof name === 'string' && name.trim().length >= 2 && name.trim().length <= 80, 'O nome deve ter entre 2 e 80 caracteres.');
  return { email: email.trim().toLowerCase(), password, ...(registration ? { name: name.trim() } : {}) };
}
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = await scrypt(password, salt, 64);
  return timingSafeEqual(Buffer.from(hash, 'hex'), candidate);
}
export function publicUser(user) {
  return { id: user._id.toString(), name: user.name, email: user.email, totalSpentCents: user.totalSpentCents, isVip: user.totalSpentCents >= VIP_THRESHOLD_CENTS, vipThresholdCents: VIP_THRESHOLD_CENTS };
}
export function publicProduct(product) {
  const { _id, ...data } = product;
  return { id: _id.toString(), ...data };
}
export function paymentMethod(value) {
  requireValue(['cash', 'card'].includes(value), 'Forma de pagamento inválida. Use cash ou card.');
  return value;
}
export async function cartView(db, user, method = 'card', session) {
  const products = await db.collection('products').find({ _id: { $in: user.cart.map(item => objectId(item.productId)) } }, { session }).toArray();
  const items = user.cart.map(item => {
    const product = products.find(p => p._id.toString() === item.productId);
    requireValue(product, 'Um produto do carrinho não está mais disponível.', 409);
    return { product: publicProduct(product), quantity: item.quantity, lineTotalCents: product.priceCents * item.quantity, available: product.stock >= item.quantity };
  });
  const subtotalCents = items.reduce((total, item) => total + item.lineTotalCents, 0);
  const discountCents = method === 'cash' ? Math.round(subtotalCents * 10 / 100) : 0;
  const isVip = user.totalSpentCents >= VIP_THRESHOLD_CENTS;
  const shippingCents = items.length === 0 || isVip ? 0 : SHIPPING_CENTS;
  return { items, itemCount: items.reduce((total, item) => total + item.quantity, 0), paymentMethod: method, subtotalCents, discountCents, shippingCents, totalCents: subtotalCents - discountCents + shippingCents, isVip, canCheckout: items.length > 0 && items.every(item => item.available) };
}
