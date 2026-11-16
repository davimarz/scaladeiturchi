'use strict';
const grid = document.getElementById('offerte');
const statusNode = document.getElementById('stato');
const more = document.getElementById('altre');
const search = document.getElementById('cerca');
const category = document.getElementById('categoria');
const maxPrice = document.getElementById('prezzo-massimo');
const sortOrder = document.getElementById('ordinamento');
const discountOnly = document.getElementById('solo-sconti');
const collator = new Intl.Collator('it', { sensitivity: 'base', numeric: true });
const blocks = new Map();
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
function card(item, parent) {
  const article = element('article', '', parent);
  const image = element('img', '', article);
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.src = item.image;
  element('h2', item.name, article);
  element('p', item.merchant, article);
  const value = element('p', '', article);
  element('strong', euro.format(price(item.price)), value);
  const original = price(item.originalPrice);
  if (onSale(item)) {
    element('del', euro.format(original), value);
    element('span', ' −' + Math.round(100 * (1 - price(item.price) / original)) + '%', value).className = 'sconto';
  }
  const link = element('a', 'Vedi offerta', article);
  link.href = item.url;
  link.target = '_blank';
  link.rel = 'sponsored noopener noreferrer';
  link.setAttribute('aria-label', 'Vedi offerta: ' + item.name);
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
  statusNode.textContent = 'Caricamento offerte…';
  const terms = normalize(search.value.trim()).split(/\s+/).filter(Boolean);
  const selected = category.value;
  const budget = maxPrice.value === '' || !maxPrice.validity.valid ? Infinity : maxPrice.valueAsNumber;
  const discounted = discountOnly.getAttribute('aria-pressed') === 'true';
  const order = sortOrder.value;
  const matches = item => (!selected || selected === categoryFamily(item.category)) &&
    price(item.price) <= budget && (!discounted || onSale(item)) &&
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
      results.sort((a, b) => {
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
    while (!order && pending.length < 24 && offset < pages.length &&
      (reads < 4 || discounted || budget !== Infinity)) {
      const size = discounted || budget !== Infinity ? 4 : 1;
      const next = await Promise.all(pages.slice(offset, offset + size).map(page => productBlock(page.file, signal)));
      if (revision !== current) return;
      offset += next.length;
      reads += next.length;
      for (const rows of next) for (const item of rows) if (matches(item)) pending.push(item);
    }
    const fragment = document.createDocumentFragment();
    pending.splice(0, 24).forEach(item => card(item, fragment));
    grid.append(fragment);
    more.hidden = !pending.length && offset >= pages.length;
    more.textContent = grid.children.length ? 'Mostra altre offerte' : 'Cerca nei prossimi prodotti';
    if (!manifest.count) {
      more.textContent = 'Riprova';
      more.hidden = false;
    }
    statusNode.textContent = grid.children.length ? grid.children.length + ' offerte mostrate'
      : !manifest.count ? 'Il catalogo non contiene ancora offerte. Riprova tra poco.'
        : more.hidden ? (discounted ? 'Nessuna offerta in sconto con questi filtri.' : 'Nessuna offerta corrispondente.')
        : 'Nessuna corrispondenza nei prodotti controllati finora.';
  } catch {
    if (revision !== current || signal.aborted) return;
    statusNode.textContent = 'Non è stato possibile caricare le offerte.';
    more.textContent = 'Riprova';
    more.hidden = false;
  } finally {
    if (loading === current) loading = undefined;
  }
}
function reset() {
  clearTimeout(timer);
  ordered = false;
  controller?.abort();
  controller = new AbortController();
  revision++;
  pages = manifest.pages.filter(page => !category.value || page.categories.some(name => categoryFamily(name) === category.value));
  offset = 0;
  pending = [];
  grid.replaceChildren();
  void load();
}
function start() {
  more.hidden = true;
  json('indice.json').then(data => {
    manifest = data;
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
category.addEventListener('change', () => { if (manifest) reset(); });
sortOrder.addEventListener('change', () => { if (manifest) reset(); });
discountOnly.addEventListener('click', () => {
  discountOnly.setAttribute('aria-pressed', String(discountOnly.getAttribute('aria-pressed') !== 'true'));
  if (manifest) reset();
});
for (const input of [search, maxPrice]) input.addEventListener('input', () => {
  clearTimeout(timer);
  if (manifest) timer = setTimeout(reset, 200);
});
start();
