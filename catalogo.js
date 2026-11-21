'use strict';
const grid = document.getElementById('offerte');
const statusNode = document.getElementById('stato');
const more = document.getElementById('altre');
const search = document.getElementById('cerca');
const merchant = document.getElementById('venditore');
const category = document.getElementById('categoria');
const minPrice = document.getElementById('prezzo-minimo');
const maxPrice = document.getElementById('prezzo-massimo');
const shuffleButton = document.getElementById('mescola-sconti');
const sortOrder = document.getElementById('ordinamento');
const discountOnly = document.getElementById('solo-sconti');
const collator = new Intl.Collator('it', { sensitivity: 'base', numeric: true });
const blocks = new Map();
const priceButtons = [...document.querySelectorAll('[data-price-band]')];
let activeBand = 'all';
const euro = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
const normalize = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// The supplier's full paths remain in the catalog; the menu uses broad families.
const categoryFamilies = [
  ['Abbigliamento', ['clothing', "men's clothing", "women's clothing", 'underwear & sleepwears', 'apparel', 'abbigliamento', 'abbigliamento uomo', 'abbigliamento femminile', 'biancheria intima']],
  ['Accessori', ['apparel accessories', 'accessories', 'accessori', 'accessori abbigliamento']],
  ['Borse e valigeria', ['luggage & bags', 'bags', 'borse', 'valigeria']],
  ['Calzature', ['shoes', 'footwear', 'calzature', 'scarpe']],
  ['Gioielli e orologi', ['jewelry & accessories', 'jewellery', 'watches', 'gioielleria', 'gioielli', 'orologi']],
  ['Elettronica e informatica', ['cellphones & telecommunications', 'computer & office', 'consumer electronics', 'informatica', 'elettronica', 'audio-video', 'accessori elettronica', 'supermercati di elettronica']],
  ['Casa e giardino', ['home appliances', 'home & garden', 'casa', 'casa e giardinaggio', 'elettrodomestici', 'mobili e arredamento', 'bricolage']],
  ['Bellezza e cura personale', ['hair extensions & wigs', 'beauty & health', 'salute e bellezza', 'bellezza']],
  ['Bambini e neonati', ['mother & kids', 'baby', 'bambini e bebè', 'abbigliamento bambini']],
  ['Sport e tempo libero', ['sports & outdoor', 'sport', 'abbigliamento sportivo', 'attrezzature sportive']],
  ['Giochi e giocattoli', ['toys & games', 'toys', 'giochi']],
  ['Animali', ['pet products', 'pet supplies', 'veterinaria e animali']],
  ['Benessere intimo', ['sex products', 'erotico']],
  ['Sigarette elettroniche', ['vape']],
];
const familyByRoot = new Map(categoryFamilies.flatMap(([family, roots]) => roots.map(root => [normalize(root), family])));
function categoryFamily(value) {
  const root = String(value ?? '').split(/\s*(?:\/|>|›|→|\|)\s*/, 1)[0].trim().replace(/[’‘]/g, "'");
  return familyByRoot.get(normalize(root)) ?? 'Altri prodotti';
}

const price = value => Number(String(value ?? '').replace(',', '.'));
let manifest, pages, pending, offset, controller, revision = 0, timer, ordered, loading;

async function json(file, signal) {
  // The index changes on every publish; hashed product blocks can stay cached.
  const index = file === 'indice.json';
  const url = './catalogo/' + file + (index ? '?aggiornamento=' + Date.now() : '');
  const response = await fetch(url, { signal, ...(index ? { cache: 'no-store' } : {}) });
  if (!response.ok) throw new Error('Catalogo non disponibile');
  return response.json();
}
function element(tag, text, parent) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  parent.append(node);
  return node;
}
// Crop only empty borders; leave the product's aspect ratio intact.
function loadPhoto(image, source) {
  const missing = () => {
    const frame = image.parentElement;
    if (!frame) return;
    image.remove();
    frame.replaceChildren(document.createTextNode('Immagine non disponibile'));
  };
  if (typeof source !== 'string' || !source.trim()) return missing();
  let url;
  try { url = new URL(source, document.baseURI); } catch { return missing(); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return missing();
  image.addEventListener('error', missing, { once: true });
  image.src = url.href;
}

function card(item, parent) {
  const article = element('a', '', parent);
  article.className = 'cisalfa-product-card';
  article.href = item.url;
  article.target = '_blank';
  article.rel = 'sponsored noopener noreferrer';
  article.setAttribute('aria-label', item.name + ' · ' + euro.format(price(item.price)) + ' · Vedi l’offerta da ' + item.merchant);
  const frame = element('div', '', article);
  frame.className = 'product-photo-frame';
  const image = element('img', '', frame);
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  loadPhoto(image, item.image);
  element('span', item.merchant, article).className = 'product-merchant';
  element('span', item.name, article).className = 'cisalfa-product-name';
  if (onSale(item)) {
    article.classList.add('has-verified-discount');
    const percent = Math.round(100 * (1 - price(item.price) / price(item.originalPrice)));
    const badge = element('span', '−' + percent + '%', article);
    badge.className = 'awin-discount-badge';
    badge.setAttribute('aria-label', 'Sconto del ' + percent + ' per cento');
    element('del', euro.format(price(item.originalPrice)), article).className = 'awin-original-price';
  }
  element('strong', euro.format(price(item.price)), article).className = 'cisalfa-product-price';
  element('span', 'Vedi l’offerta', article).className = 'offer-cta';
}
function onSale(item) {
  return price(item.price) > 0 && price(item.originalPrice) > price(item.price);
}
async function productBlock(file, signal) {
  if (blocks.has(file)) return blocks.get(file);
  const rows = await json(file, signal);
  blocks.set(file, rows);
  return rows;
}
async function load() {
  if (loading === revision) return;
  const current = revision;
  loading = current;
  const signal = controller.signal;
  more.hidden = true;
  statusNode.textContent = 'Caricamento delle promozioni…';
  grid.setAttribute('aria-busy', 'true');
  const terms = normalize(search.value.trim()).split(/\s+/).filter(Boolean);
  const selected = category.value;
  const seller = merchant.value;
  if (!minPrice.validity.valid || !maxPrice.validity.valid) {
    statusNode.textContent = 'Inserisci prezzi validi, da 0 € in su, con al massimo due decimali.';
    loading = undefined;
    grid.setAttribute('aria-busy', 'false');
    return;
  }
  const lower = minPrice.value === '' ? 0 : minPrice.valueAsNumber;
  const upper = maxPrice.value === '' ? Infinity : maxPrice.valueAsNumber;
  if (lower > upper) {
    statusNode.textContent = 'Il prezzo minimo deve essere minore o uguale al prezzo massimo.';
    loading = undefined;
    return;
  }
  const priceFilter = minPrice.value !== '' || maxPrice.value !== '';
  const order = sortOrder.value === 'discount' ? '' : sortOrder.value;
  const discounted = order === 'shuffle' || discountOnly.getAttribute('aria-pressed') === 'true';
  const matches = item => (!seller || item.merchant === seller) && (!selected || selected === categoryFamily(item.category)) &&
    price(item.price) >= lower && price(item.price) <= upper && (!discounted || onSale(item)) &&
    terms.every(term => normalize([item.name, item.brand, item.merchant].join(' ')).includes(term));
  try {
    // An explicit sort must see all results before showing the first page.
    if (order && !ordered) {
      const results = [];
      for (let start = 0; start < pages.length; start += 4) {
        const next = await Promise.all(pages.slice(start, start + 4).map(page => productBlock(page.file, signal)));
        if (revision !== current) return;
        for (const rows of next) for (const item of rows) if (matches(item)) results.push(item);
      }
      if (order === 'shuffle') {
        for (let i = results.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [results[i], results[j]] = [results[j], results[i]];
        }
      } else results.sort((a, b) => {
        const byName = () => collator.compare(a.name, b.name);
        if (order === 'name') return byName();
        const difference = price(a.price) - price(b.price);
        return (order === 'price-desc' ? -difference : difference) || byName();
      });
      pending = results;
      offset = pages.length;
      ordered = true;
    }
    let reads = 0;
    while (!order && pending.length < 6 && offset < pages.length &&
      (reads < 4 || discounted || priceFilter || seller)) {
      const size = discounted || priceFilter || seller ? 4 : 1;
      const next = await Promise.all(pages.slice(offset, offset + size).map(page => productBlock(page.file, signal)));
      if (revision !== current) return;
      offset += next.length;
      reads += next.length;
      for (const rows of next) for (const item of rows) if (matches(item)) pending.push(item);
    }
    const fragment = document.createDocumentFragment();
    pending.splice(0, 6).forEach(item => card(item, fragment));
    grid.append(fragment);
    more.hidden = !pending.length && offset >= pages.length;
    more.textContent = grid.children.length ? 'Mostra altri prodotti' : 'Cerca nei prossimi prodotti';
    if (!manifest.count) {
      more.textContent = 'Riprova';
      more.hidden = false;
    }
    statusNode.textContent = grid.children.length ? grid.children.length + ' prodotti mostrati' + (offset >= pages.length ? ' su ' + (grid.children.length + pending.length) + ' disponibili' : '')
      : !manifest.count ? 'Il catalogo non contiene ancora offerte. Riprova tra poco.'
        : more.hidden ? (discounted ? 'Nessuna offerta in sconto con questi filtri.' : 'Nessuna offerta corrispondente.')
        : 'Nessuna corrispondenza nei prodotti controllati finora.';
  } catch {
    if (revision !== current || signal.aborted) return;
    statusNode.textContent = 'Non è stato possibile caricare le offerte.';
    more.textContent = 'Riprova';
    more.hidden = false;
  } finally {
    if (loading === current) { loading = undefined; grid.setAttribute('aria-busy', 'false'); }
  }
}
function reset() {
  clearTimeout(timer);
  ordered = false;
  controller?.abort();
  controller = new AbortController();
  revision++;
  pages = manifest.pages.filter(page =>
    (!category.value || page.categories.some(name => categoryFamily(name) === category.value)) &&
    (!merchant.value || !page.merchants || page.merchants.includes(merchant.value)));
  offset = 0;
  pending = [];
  grid.replaceChildren();
  void load();
}
function start() {
  more.hidden = true;
  json('indice.json').then(data => {
    manifest = data;
    merchant.replaceChildren(new Option('Tutti i venditori', ''));
    for (const name of [...(data.merchants ?? [])].sort(collator.compare)) merchant.add(new Option(name, name));
    merchant.disabled = !data.merchants?.length;
    category.replaceChildren(new Option('Tutte le categorie', ''));
    const families = [...new Set(data.categories.map(categoryFamily))];
    families.sort((a, b) => (a === 'Altri prodotti') - (b === 'Altri prodotti') || a.localeCompare(b, 'it'));
    for (const name of families) category.add(new Option(name, name));
    reset();
  }).catch(() => {
    statusNode.textContent = 'Catalogo non disponibile.';
    more.textContent = 'Riprova';
    more.hidden = false;
  });
}
more.addEventListener('click', () => manifest?.count ? load() : start());
merchant.addEventListener('change', () => { if (manifest) reset(); });
category.addEventListener('change', () => { if (manifest) reset(); });
shuffleButton?.addEventListener('click', () => {
  sortOrder.value = 'shuffle';
  if (manifest) reset();
});
sortOrder.addEventListener('change', () => { if (manifest) reset(); });
function updatePriceButtons() {
  for (const button of priceButtons) button.setAttribute('aria-pressed', String(button.dataset.priceBand === activeBand));
}
for (const button of priceButtons) button.addEventListener('click', () => {
  activeBand = button.dataset.priceBand;
  if (activeBand === 'all') {
    search.value = ''; category.value = ''; merchant.value = '';
    minPrice.value = ''; maxPrice.value = ''; sortOrder.value = '';
  }
  updatePriceButtons();
  if (manifest) reset();
});
for (const input of [search, minPrice, maxPrice]) input.addEventListener('input', () => {
  clearTimeout(timer);
  if (manifest) timer = setTimeout(reset, 200);
});
start();
