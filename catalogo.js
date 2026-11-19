'use strict';
const grid = document.getElementById('offerte');
const statusNode = document.getElementById('stato');
const more = document.getElementById('altre');
const search = document.getElementById('cerca');
const merchant = document.getElementById('venditore');
const category = document.getElementById('categoria');
const minPrice = document.getElementById('prezzo-minimo');
const maxPrice = document.getElementById('prezzo-massimo');
const sortOrder = document.getElementById('ordinamento');
const discountOnly = document.getElementById('solo-sconti');
const collator = new Intl.Collator('it', { sensitivity: 'base', numeric: true });
const blocks = new Map();
const resetButton = document.getElementById('azzera-filtri');
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
function photoBounds(pixels, width, height) {
  let left = width, right = -1, top = height, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (pixels[i + 3] < 20 || Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) >= 248) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < left || bottom < top || right - left < width * .08 || bottom - top < height * .08) return null;
  if (Math.max(left / width, (width - 1 - right) / width, top / height, (height - 1 - bottom) / height) < .08) return null;
  const margin = Math.ceil(Math.max(right - left, bottom - top) * .025);
  const x = Math.max(0, left - margin), y = Math.max(0, top - margin);
  return { x, y, width: Math.min(width, right + margin + 1) - x,
    height: Math.min(height, bottom + margin + 1) - y };
}

function trimPhoto(image) {
  const sourceWidth = image.naturalWidth, sourceHeight = image.naturalHeight;
  if (!sourceWidth || !sourceHeight) return;
  const scale = Math.min(1, 512 / Math.max(sourceWidth, sourceHeight));
  const sample = document.createElement('canvas');
  sample.width = Math.max(1, Math.round(sourceWidth * scale));
  sample.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = sample.getContext('2d', { willReadFrequently: true });
  if (!context) return;
  context.drawImage(image, 0, 0, sample.width, sample.height);
  const bounds = photoBounds(context.getImageData(0, 0, sample.width, sample.height).data, sample.width, sample.height);
  if (!bounds) return;

  const full = { x: bounds.x * sourceWidth / sample.width, y: bounds.y * sourceHeight / sample.height,
    width: bounds.width * sourceWidth / sample.width, height: bounds.height * sourceHeight / sample.height };
  const crop = document.createElement('canvas');
  const outputScale = Math.min(1, 960 / Math.max(full.width, full.height));
  crop.width = Math.max(1, Math.round(full.width * outputScale));
  crop.height = Math.max(1, Math.round(full.height * outputScale));
  const output = crop.getContext('2d');
  if (!output) return;
  output.drawImage(image, full.x, full.y, full.width, full.height, 0, 0, crop.width, crop.height);
  crop.toBlob(blob => {
    if (!blob || !image.isConnected) return;
    const url = URL.createObjectURL(blob);
    const original = image.src;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      image.removeEventListener('load', loaded);
      image.removeEventListener('error', failed);
    };
    const loaded = () => cleanup();
    const failed = () => { cleanup(); image.src = original; };
    image.addEventListener('load', loaded);
    image.addEventListener('error', failed);
    image.src = url;
  }, 'image/webp', .92);
}

function loadPhoto(image, source) {
  let url;
  try { url = new URL(source, document.baseURI); } catch { return; }
  if (!['http:', 'https:'].includes(url.protocol)) return;
  const original = () => {
    image.removeEventListener('load', loaded);
    image.removeAttribute('crossorigin');
    if (image.isConnected) image.src = source;
  };
  const loaded = () => {
    image.removeEventListener('error', original);
    try { trimPhoto(image); } catch { /* Keep the original if pixels are inaccessible. */ }
  };
  image.crossOrigin = 'anonymous';
  image.addEventListener('error', original, { once: true });
  image.addEventListener('load', loaded, { once: true });
  image.src = source;
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
  const discounted = discountOnly.getAttribute('aria-pressed') === 'true';
  const order = sortOrder.value;
  const matches = item => (!seller || item.merchant === seller) && (!selected || selected === categoryFamily(item.category)) &&
    price(item.price) >= lower && price(item.price) <= upper && (!(activeBand === 'mid' || activeBand === 'high') || price(item.price) > lower) && (!discounted || onSale(item)) &&
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
  resetButton.hidden = !search.value.trim() && !category.value && !merchant.value &&
    !minPrice.value && !maxPrice.value && !sortOrder.value && discountOnly.getAttribute('aria-pressed') !== 'true';
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
sortOrder.addEventListener('change', () => { if (manifest) reset(); });
function updatePriceButtons() {
  for (const button of priceButtons) button.setAttribute('aria-pressed', String(button.dataset.priceBand === activeBand));
}
for (const button of priceButtons) button.addEventListener('click', () => {
  activeBand = button.dataset.priceBand;
  minPrice.value = activeBand === 'mid' ? '50' : activeBand === 'high' ? '150' : '';
  maxPrice.value = activeBand === 'low' ? '50' : activeBand === 'mid' ? '150' : '';
  updatePriceButtons();
  if (manifest) reset();
});
resetButton.addEventListener('click', () => {
  search.value = ''; category.value = ''; merchant.value = ''; minPrice.value = ''; maxPrice.value = ''; sortOrder.value = '';
  activeBand = 'all'; updatePriceButtons();
  if (manifest) reset();
});
for (const input of [search, minPrice, maxPrice]) input.addEventListener('input', () => {
  clearTimeout(timer);
  if (input === minPrice || input === maxPrice) {
    activeBand = 'custom';
    for (const button of priceButtons) if (button !== discountOnly) button.setAttribute('aria-pressed', 'false');
  }
  if (manifest) timer = setTimeout(reset, 200);
});
start();
