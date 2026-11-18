import { randomUUID } from 'node:crypto';
import { ApiError, publicUser } from './security.js';

export const SHIPPING_CENTS = 2000;

export function totals(subtotalCents, isVip, paymentMethod, hasItems = true) {
  const discountCents = paymentMethod === 'cash' ? Math.round(subtotalCents * 10 / 100) : 0;
  const shippingCents = hasItems && !isVip ? SHIPPING_CENTS : 0;
  return { subtotalCents, discountCents, shippingCents, totalCents: subtotalCents - discountCents + shippingCents };
}

export function createShop({ client, db }) {
  const users = db.collection('users');
  const products = db.collection('products');
  const orders = db.collection('orders');

  const transaction = callback => client.withSession(session => session.withTransaction(() => callback(session)));

  async function getUser(userId, session) {
    const user = await users.findOne({ _id: userId }, { session });
    if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Entre na sua conta para continuar.');
    return user;
  }

  async function cartView(user, session) {
    const catalog = await products.find({ _id: { $in: user.cart.map(item => item.productId) } }, { session }).toArray();
    const items = user.cart.map(item => {
      const product = catalog.find(product => product._id === item.productId);
      if (!product) throw new ApiError(409, 'PRODUCT_UNAVAILABLE', 'Um produto do carrinho não está mais disponível.');
      return {
        productId: product._id, name: product.name, image: product.image,
        quantity: item.quantity, stock: product.stock, unitPriceCents: product.priceCents,
        lineTotalCents: product.priceCents * item.quantity, available: product.stock >= item.quantity,
      };
    });
    const subtotalCents = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
    const isVip = publicUser(user).isVip;
    return {
      items, itemCount: items.reduce((sum, item) => sum + item.quantity, 0), isVip,
      cash: totals(subtotalCents, isVip, 'cash', items.length > 0),
      card: totals(subtotalCents, isVip, 'card', items.length > 0),
    };
  }

  async function changeCart(userId, productId, quantity, mode) {
    return transaction(async session => {
      const user = await getUser(userId, session);
      const current = user.cart.find(item => item.productId === productId);
      if (mode !== 'add' && !current) throw new ApiError(404, 'CART_ITEM_NOT_FOUND', 'Este produto não está no seu carrinho.');
      if (mode === 'remove') {
        user.cart = user.cart.filter(item => item.productId !== productId);
      } else {
        const product = await products.findOne({ _id: productId }, { session });
        if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Produto não encontrado.');
        const next = mode === 'add' ? (current?.quantity ?? 0) + quantity : quantity;
        if (next > 99 || product.stock < next) throw new ApiError(409, 'INSUFFICIENT_STOCK', `Estoque insuficiente. Disponível: ${product.stock} unidade(s).`);
        user.cart = [...user.cart.filter(item => item.productId !== productId), { productId, quantity: next }];
      }
      await users.updateOne({ _id: userId }, { $set: { cart: user.cart } }, { session });
      return cartView(user, session);
    });
  }

  async function checkout(userId, input, idempotencyKey) {
    return transaction(async session => {
      const previous = await orders.findOne({ userId, idempotencyKey }, { session });
      if (previous) return { order: publicOrder(previous), user: publicUser(await getUser(userId, session)) };
      const user = await getUser(userId, session);
      if (!user.cart.length) throw new ApiError(400, 'EMPTY_CART', 'Adicione um produto ao carrinho antes de finalizar.');
      const cart = await cartView(user, session);
      for (const item of cart.items) {
        const reserved = await products.updateOne(
          { _id: item.productId, stock: { $gte: item.quantity } },
          { $inc: { stock: -item.quantity } }, { session },
        );
        if (!reserved.modifiedCount) throw new ApiError(409, 'INSUFFICIENT_STOCK', `${item.name}: estoque insuficiente. Atualize seu carrinho.`);
      }
      const summary = input.paymentMethod === 'cash' ? cart.cash : cart.card;
      const newSpent = user.totalSpentCents + summary.subtotalCents - summary.discountCents;
      const order = {
        _id: randomUUID(), userId, idempotencyKey,
        number: `MP-${randomUUID().slice(0, 8).toUpperCase()}`,
        items: cart.items.map(({ productId, name, quantity, unitPriceCents, lineTotalCents }) => ({ productId, name, quantity, unitPriceCents, lineTotalCents })),
        ...summary, paymentMethod: input.paymentMethod, address: input.address,
        wasVip: cart.isVip, becameVip: !cart.isVip && newSpent >= 30000, createdAt: new Date(),
      };
      await orders.insertOne(order, { session });
      await users.updateOne({ _id: userId }, { $set: { totalSpentCents: newSpent, cart: [] } }, { session });
      return { order: publicOrder(order), user: publicUser({ ...user, totalSpentCents: newSpent }) };
    });
  }

  return { getUser, cartView, changeCart, checkout };
}

export function publicOrder(order) {
  const { _id, userId, idempotencyKey, ...details } = order;
  return { id: _id, ...details };
}
