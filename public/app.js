const $ = selector => document.querySelector(selector);
const money = cents => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const state = { user: null, products: [], cart: null, authMode: 'login', pendingAction: null, cartBusy: false, checkoutKey: null };
let toastTimer;

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method, credentials: 'same-origin', headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
  } catch {
    throw new Error('Não foi possível conectar à loja. Verifique sua conexão e tente novamente.');
  }
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error?.details?.[0]?.message ?? data.error?.message ?? 'Não foi possível concluir a operação.');
    error.status = response.status;
    error.code = data.error?.code;
    throw error;
  }
  return data;
}

function showError(id, message) { $(id).textContent = message; $(id).hidden = false; }
function clearError(id) { $(id).textContent = ''; $(id).hidden = true; }
function openDialog(id) { if (!$(id).open) $(id).showModal(); }

function renderMember() {
  $('#account-button').textContent = state.user ? `${state.user.name.split(' ')[0]}${state.user.isVip ? ' · VIP' : ''}` : 'Entrar ↗';
  $('#logout-button').hidden = !state.user;
  $('#member-panel').hidden = !state.user;
  if (!state.user) { $('#member-panel').innerHTML = ''; return; }
  const user = state.user;
  $('#member-panel').innerHTML = `<div><strong>Olá, ${escapeHtml(user.name.split(' ')[0])}. ${user.isVip ? 'Você já é cliente VIP!' : 'Seu próximo nível está chegando.'}</strong><p>${user.isVip ? 'Seu frete é grátis em todas as compras.' : `Faltam ${money(user.remainingForVipCents)} em peças, após descontos, para liberar seu frete grátis.`}</p>${user.isVip ? '' : `<div class="vip-progress"><progress max="30000" value="${Math.min(user.totalSpentCents, 30000)}" aria-label="Progresso para se tornar VIP"></progress></div>`}</div><span class="member-badge">${user.isVip ? 'VIP ✦' : `${money(user.totalSpentCents)} / R$ 300`}</span>`;
}

function renderProducts() {
  $('#products').innerHTML = state.products.map(product => `<article class="product-card"><div class="product-visual"><span class="product-tag">${escapeHtml(product.tag)}</span><img src="${escapeHtml(product.image)}" alt="Ilustração de ${escapeHtml(product.name)}" width="500" height="400"></div><div class="product-body"><div class="product-category">${escapeHtml(product.category)}</div><h3>${escapeHtml(product.name)}</h3><p class="product-description">${escapeHtml(product.description)}</p><div class="product-stock ${product.stock === 0 ? 'unavailable' : ''}">${product.stock > 0 ? `${product.stock} unidades em estoque` : 'Indisponível no momento'}</div><div class="product-price-row"><div><div class="product-price"><span class="price-prefix">R$</span>${escapeHtml((product.priceCents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }))}</div><div class="product-cash">ou ${money(product.priceCents - Math.round(product.priceCents * .1))} em dinheiro</div></div></div><button type="button" class="button dark full" data-add="${escapeHtml(product.id)}" aria-label="Adicionar ${escapeHtml(product.name)} ao carrinho" ${product.stock === 0 ? 'disabled' : ''}>${product.stock > 0 ? 'Adicionar ao carrinho <span aria-hidden="true">+</span>' : 'Sem estoque'}</button></div></article>`).join('');
}

async function loadProducts() {
  $('#catalog-error').hidden = true;
  try { state.products = (await api('/products')).products; renderProducts(); }
  catch (error) { $('#products').innerHTML = ''; $('#catalog-error').hidden = false; throw error; }
}

function summaryHtml(summary, { cash = false, vip = false } = {}) {
  return `<div class="summary"><div class="summary-line"><span>Subtotal em peças</span><span>${money(summary.subtotalCents)}</span></div>${cash ? `<div class="summary-line discount"><span>Desconto em dinheiro (10%)</span><span>− ${money(summary.discountCents)}</span></div>` : ''}<div class="summary-line"><span>Frete${vip ? ' VIP' : ''}</span><span>${summary.shippingCents === 0 ? 'Grátis' : money(summary.shippingCents)}</span></div><div class="summary-line total"><span>Total</span><span>${money(summary.totalCents)}</span></div></div>`;
}

function renderCart() {
  $('#cart-count').textContent = state.cart?.itemCount ?? 0;
  if (!state.cart?.items.length) {
    $('#cart-content').innerHTML = '<div class="cart-empty"><span class="empty-icon" aria-hidden="true">↗</span><h3>Seu próximo caminho começa aqui.</h3><p>Adicione uma peça e deixe sua moto<br>pronta para seguir em frente.</p><button type="button" class="button dark" data-close="cart-dialog">Explorar as peças <span aria-hidden="true">↗</span></button></div>';
    return;
  }
  $('#cart-content').innerHTML = state.cart.items.map(item => `<article class="cart-item"><img src="${escapeHtml(item.image)}" alt="" width="75" height="80"><div><h3>${escapeHtml(item.name)}</h3><span class="item-price">${money(item.lineTotalCents)}</span>${!item.available ? `<p class="stock-alert">Estoque atualizado: ${item.stock} unidade(s). Ajuste a quantidade ou remova o item.</p>` : ''}<div class="quantity-row"><div class="quantity-control"><button type="button" data-quantity="${escapeHtml(item.productId)}" data-value="${item.quantity - 1}" aria-label="Diminuir quantidade de ${escapeHtml(item.name)}" ${item.quantity <= 1 ? 'disabled' : ''}>−</button><span aria-label="Quantidade">${item.quantity}</span><button type="button" data-quantity="${escapeHtml(item.productId)}" data-value="${item.quantity + 1}" aria-label="Aumentar quantidade de ${escapeHtml(item.name)}" ${item.quantity >= item.stock || item.quantity >= 99 ? 'disabled' : ''}>+</button></div><button type="button" class="remove-item" data-remove="${escapeHtml(item.productId)}">Remover</button></div></div></article>`).join('') + summaryHtml(state.cart.card, { vip: state.cart.isVip }) + `<p class="cart-note">${state.cart.isVip ? 'Seu benefício VIP já garante o frete grátis.' : 'Frete fixo de R$ 20. Clientes VIP têm frete grátis.'}<br>Escolha dinheiro na próxima etapa para ganhar 10% de desconto nas peças. O estoque é confirmado ao finalizar.</p><button type="button" class="button dark full" id="begin-checkout" ${state.cart.items.some(item => !item.available) ? 'disabled' : ''}>Continuar para entrega <span aria-hidden="true">↗</span></button>`;
}

async function loadCart() { state.cart = await api('/cart'); renderCart(); }

function openAuth(action = null) {
  state.pendingAction = action;
  clearError('#auth-error');
  openDialog('#auth-dialog');
}

function setAuthMode(mode) {
  state.authMode = mode;
  const register = mode === 'register';
  $('#login-tab').classList.toggle('active', !register);
  $('#register-tab').classList.toggle('active', register);
  $('#login-tab').setAttribute('aria-pressed', String(!register));
  $('#register-tab').setAttribute('aria-pressed', String(register));
  $('#name-field').hidden = !register;
  $('#name-field input').disabled = !register;
  $('#name-field input').required = register;
  $('#auth-form [name=password]').autocomplete = register ? 'new-password' : 'current-password';
  $('#auth-title').textContent = register ? 'Seu próximo caminho começa aqui.' : 'Bom ter você por aqui.';
  $('#auth-description').textContent = register ? 'Crie sua conta e comece a acumular benefícios.' : 'Entre para equipar sua próxima jornada.';
  $('#auth-submit').innerHTML = `${register ? 'Criar minha conta' : 'Entrar na minha conta'} <span aria-hidden="true">↗</span>`;
  clearError('#auth-error');
}

async function sessionExpired(error) {
  if (error.status !== 401) return false;
  state.user = null; state.cart = null; state.checkoutKey = null;
  renderMember(); renderCart();
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  openAuth();
  showError('#auth-error', 'Sua sessão terminou. Entre novamente para continuar.');
  return true;
}

async function addProduct(productId, button) {
  if (!state.user) { openAuth({ type: 'add', productId }); return; }
  if (button) button.disabled = true;
  try {
    state.cart = await api('/cart/items', { method: 'POST', body: { productId, quantity: 1 } });
    state.checkoutKey = null; renderCart(); toast('Peça adicionada. Seu próximo caminho está mais perto!');
  } catch (error) {
    if (!await sessionExpired(error)) toast(error.message);
    await loadProducts().catch(() => {});
  } finally { if (button) button.disabled = false; }
}

async function openCart() {
  if (!state.user) { openAuth({ type: 'cart' }); return; }
  clearError('#cart-error');
  try { await loadCart(); openDialog('#cart-dialog'); }
  catch (error) { if (!await sessionExpired(error)) toast(error.message); }
}

async function mutateCart(path, options) {
  if (state.cartBusy) return;
  state.cartBusy = true; clearError('#cart-error');
  $('#cart-content').querySelectorAll('button').forEach(button => { button.disabled = true; });
  try { state.cart = await api(path, options); state.checkoutKey = null; }
  catch (error) {
    if (!await sessionExpired(error)) { showError('#cart-error', error.message); await loadCart().catch(() => {}); }
  } finally { state.cartBusy = false; renderCart(); }
}

function renderCheckoutSummary() {
  if (!state.cart) return;
  const cash = $('#checkout-form [name=paymentMethod]:checked').value === 'cash';
  $('#checkout-summary').innerHTML = summaryHtml(cash ? state.cart.cash : state.cart.card, { cash, vip: state.cart.isVip });
}

function openCheckout() {
  if (!state.cart?.items.length || state.cartBusy) return;
  state.checkoutKey ??= crypto.randomUUID();
  $('#checkout-form [name=recipient]').value ||= state.user.name;
  clearError('#checkout-error'); renderCheckoutSummary();
  $('#cart-dialog').close(); openDialog('#checkout-dialog');
}

document.addEventListener('click', event => {
  const close = event.target.closest('[data-close]');
  if (close) document.getElementById(close.dataset.close).close();
});
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('click', event => {
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    }
  });
});
$('#account-button').addEventListener('click', () => state.user ? toast(state.user.isVip ? 'Você é VIP! Seu frete é grátis em todas as compras.' : `Faltam ${money(state.user.remainingForVipCents)} em peças para você virar VIP.`) : openAuth());
$('#login-tab').addEventListener('click', () => setAuthMode('login'));
$('#register-tab').addEventListener('click', () => setAuthMode('register'));
$('#cart-button').addEventListener('click', openCart);
$('#retry-products').addEventListener('click', () => loadProducts().catch(error => toast(error.message)));
$('#products').addEventListener('click', event => { const button = event.target.closest('[data-add]'); if (button) addProduct(button.dataset.add, button); });
$('#cart-content').addEventListener('click', event => {
  const quantity = event.target.closest('[data-quantity]');
  const remove = event.target.closest('[data-remove]');
  if (quantity) mutateCart(`/cart/items/${encodeURIComponent(quantity.dataset.quantity)}`, { method: 'PATCH', body: { quantity: Number(quantity.dataset.value) } });
  if (remove) mutateCart(`/cart/items/${encodeURIComponent(remove.dataset.remove)}`, { method: 'DELETE' });
  if (event.target.closest('#begin-checkout')) openCheckout();
});

$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault(); clearError('#auth-error');
  const button = $('#auth-submit'); button.disabled = true;
  const values = Object.fromEntries(new FormData(event.target));
  if (state.authMode === 'login') delete values.name;
  try {
    state.user = (await api(`/auth/${state.authMode}`, { method: 'POST', body: values })).user;
    renderMember(); event.target.reset(); $('#auth-dialog').close();
    await loadCart();
    const action = state.pendingAction; state.pendingAction = null;
    if (action?.type === 'add') { await addProduct(action.productId); await openCart(); }
    else if (action?.type === 'cart') await openCart();
    else toast(`Bom ter você por aqui, ${state.user.name.split(' ')[0]}!`);
  } catch (error) {
    if ($('#auth-dialog').open) showError('#auth-error', error.message);
    else toast(error.message);
  } finally { button.disabled = false; }
});

$('#logout-button').addEventListener('click', async () => {
  const button = $('#logout-button'); button.disabled = true;
  try {
    await api('/auth/logout', { method: 'POST' });
    state.user = null; state.cart = null; state.checkoutKey = null; state.pendingAction = null;
    $('#checkout-form').reset(); renderMember(); renderCart(); toast('Você saiu da sua conta. Até o próximo caminho!');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

$('#checkout-form').addEventListener('change', renderCheckoutSummary);
$('#back-to-cart').addEventListener('click', () => { $('#checkout-dialog').close(); openCart(); });
$('#checkout-form').addEventListener('submit', async event => {
  event.preventDefault(); clearError('#checkout-error');
  const button = $('#place-order'); button.disabled = true; button.textContent = 'Confirmando…';
  const values = Object.fromEntries(new FormData(event.target));
  const { paymentMethod, ...address } = values;
  try {
    const result = await api('/checkout', { method: 'POST', body: { paymentMethod, address }, headers: { 'Idempotency-Key': state.checkoutKey } });
    state.user = result.user; state.checkoutKey = null;
    const order = result.order;
    state.cart = null; renderMember(); renderCart();
    $('#checkout-dialog').close();
    $('#success-content').innerHTML = `<p class="success-order">Pedido <strong>${escapeHtml(order.number)}</strong><br>${order.items.reduce((sum, item) => sum + item.quantity, 0)} peça(s) para o seu próximo caminho.</p>${summaryHtml(order, { cash: order.paymentMethod === 'cash', vip: order.wasVip })}${order.becameVip ? '<div class="new-vip"><strong>Você acaba de se tornar VIP! ✦</strong><br>O frete será grátis a partir da sua próxima compra.</div>' : ''}<p class="simulation-note">Compra demonstrativa. Nenhuma cobrança ou entrega real será realizada.</p>`;
    openDialog('#success-dialog');
    await loadProducts().catch(() => {});
    await loadCart().catch(() => {});
  } catch (error) {
    if (!await sessionExpired(error)) {
      showError('#checkout-error', error.message);
      await loadCart().then(renderCheckoutSummary).catch(() => {});
      await loadProducts().catch(() => {});
    }
  } finally { button.disabled = false; button.innerHTML = 'Confirmar compra <span aria-hidden="true">↗</span>'; }
});

const stateOptions = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];
$('#checkout-form [name=state]').insertAdjacentHTML('beforeend', stateOptions.map(state => `<option value="${state}">${state}</option>`).join(''));
async function initialize() {
  await Promise.allSettled([
    loadProducts(),
    (async () => {
      try { state.user = (await api('/auth/me')).user; renderMember(); await loadCart(); }
      catch (error) { if (error.status !== 401) toast(error.message); }
    })(),
  ]);
}
initialize();
