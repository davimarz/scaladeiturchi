// Parser e validazione adattati dall’importatore ArchivioScarpe di Davide Marziano.
const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const sourceExtension = /\.(?:csv|tsv|jsonl|ndjson)(?:\.gz)?$|\.gz$/i;

function* csvRows(text, separator) {
  let row = [];
  let start = 0;
  let record = 1;
  const isBoundary = c => c === separator || c === '\r' || c === '\n' || c === undefined;
  const skipPadding = position => {
    while (text[position] === ' ' || (separator !== '\t' && text[position] === '\t')) position++;
    return position;
  };
  while (start < text.length) {
    let end = start;
    const quoteStart = skipPadding(start);
    if (text[quoteStart] === '"') {
      let quoteEnd = text.indexOf('"', quoteStart + 1);
      while (quoteEnd !== -1) {
        if (text[quoteEnd + 1] === '"') {
          quoteEnd = text.indexOf('"', quoteEnd + 2);
          continue;
        }
        if (isBoundary(text[skipPadding(quoteEnd + 1)])) break;
        // An unescaped quote followed by text is part of the field.
        quoteEnd = text.indexOf('"', quoteEnd + 1);
      }
      if (quoteEnd === -1) throw new Error('record CSV ' + record + ': virgolette non chiuse');
      row.push(text.slice(quoteStart + 1, quoteEnd).replaceAll('""', '"'));
      end = skipPadding(quoteEnd + 1);
    } else {
      while (!isBoundary(text[end])) end++;
      row.push(text.slice(start, end));
    }
    if (text[end] === separator) {
      start = end + 1;
      if (start === text.length) row.push('');
      continue;
    }
    if (!isBoundary(text[end])) {
      throw new Error('record CSV ' + record + ': carattere inatteso dopo le virgolette');
    }
    if (row.some(Boolean)) yield row;
    record++;
    row = [];
    start = end + (text[end] === '\r' && text[end + 1] === '\n' ? 2 : 1);
  }
  if (row.some(Boolean)) yield row;
}

function detectCsvSeparator(header) {
  for (const separator of [',', ';', '|', '\t']) {
    try {
      const fields = csvRows(header, separator).next().value ?? [];
      const normalized = fields.map(field => field.trim().toLowerCase());
      if (normalized.some(field => field === 'product_name' || field === 'title') &&
          normalized.some(field => ['search_price', 'store_price', 'price', 'display_price', 'sale_price'].includes(field))) {
        return separator;
      }
    } catch {
      // Other delimiters can make a quoted header appear invalid.
    }
  }
  throw new Error('intestazione CSV prodotti non riconosciuta');
}

function* records(filename, reportInvalid) {
  let bytes = fs.readFileSync(filename);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8';
  const text = bytes.toString(encoding).trimStart().replace(/^sep=[,;|\t]\r?\n/i, '');
  if (text.startsWith('{')) {
    for (let start = 0; start < text.length;) {
      const nextLine = text.indexOf('\n', start);
      const end = nextLine < 0 ? text.length : nextLine;
      const line = text.slice(start, end).trim();
      start = end + 1;
      if (!line) continue;
      const record = JSON.parse(line);
      if (!record || record.error) throw new Error('il feed JSONL segnala un errore');
      yield Object.assign({}, ...Object.values(record).filter(value => value && typeof value === 'object' && !Array.isArray(value)), record);
    }
    return;
  }
  const firstLine = text.split(/\r?\n/, 1)[0];
  const separator = detectCsvSeparator(firstLine);
  const rows = csvRows(text, separator);
  const headers = (rows.next().value ?? []).map(field => field.trim().toLowerCase());
  if (headers.length < 2 || !headers.some(field => /^(product_name|title)$/.test(field))) {
    throw new Error('intestazione CSV prodotti non riconosciuta');
  }
  let record = 1;
  for (const row of rows) {
    record++;
    if (row.length !== headers.length) {
      reportInvalid(record, row.length, headers.length);
      continue;
    }
    yield Object.fromEntries(headers.map((field, index) => [field, row[index]]));
  }
}

const clean = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const pick = (...values) => values.map(clean).find(Boolean) || '';
const normalize = value => clean(value).toLowerCase().replace(/\s+/g, ' ');

function cents(value, currency) {
  const raw = typeof value === 'object' && value ? pick(value.amount, value.value) : clean(value);
  const unit = typeof value === 'object' && value ? pick(value.currency, value.currency_code, value.currencyCode, currency) : clean(currency);
  if (unit && !/^(EUR|€)$/i.test(unit)) return null;
  const match = raw.match(/^(?:EUR\s*|€\s*)?(\d+(?:[.,]\d{1,2})?)\s*(?:EUR|€)?$/i);
  if (!match || (!unit && !/EUR|€/i.test(raw))) return null;
  const result = Math.round(Number(match[1].replace(',', '.')) * 100);
  return Number.isSafeInteger(result) ? result : null;
}

function https(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function trackingLink(record, publisher) {
  for (const value of [record.aw_deep_link, record.awin_deep_link, record.awin_link, record.affiliate_link, record.link]) {
    const url = https(value);
    if (url && /^(?:www\.)?awin1\.com$/i.test(url.hostname) &&
        (url.searchParams.get('a') === publisher || url.searchParams.get('awinaffid') === publisher)) {
      return url.href;
    }
  }
  const merchantId = pick(record.merchant_id, record.advertiser_id);
  const destination = https(pick(record.merchant_deep_link, record.link));
  if (!/^\d+$/.test(merchantId) || !destination ||
      /^(?:www\.)?awin1\.com$/i.test(destination.hostname)) return '';
  const link = new URL('https://www.awin1.com/cread.php');
  link.search = new URLSearchParams({ awinmid: merchantId, awinaffid: publisher, ued: destination.href });
  return link.href;
}


const commonColours = new Set(('nero|bianco|rosso|verde|blu|azzurro|grigio|giallo|rosa|viola|lilla|marrone|arancione|beige|bordeaux|multicolore|black|white|red|green|blue|grey|gray|yellow|pink|purple|brown|orange|multicolor').split('|'));
const modelText = value => normalize(value).normalize('NFKC').replace(/[‐‑–—]/g, '-');
function modelVariant(record, name, merchant, category) {
  const size = modelText(pick(record['fashion:size'], record.size, record.product_size));
  const colour = modelText(pick(record.colour, record.color, record.product_colour, record.product_color));
  const genderText = modelText([pick(record.gender, record['fashion:gender']), name, category].join(' '));
  const woman = /(?:^|\W)(?:donna|women|woman|female|femminile)(?:\W|$)/i.test(genderText);
  const man = /(?:^|\W)(?:uomo|men|man|male|maschile)(?:\W|$)/i.test(genderText);
  const gender = woman && !man ? 'donna' : man && !woman ? 'uomo' : '';
  const preferred = gender === 'donna' ? ['m', 's'] : gender === 'uomo' ? ['m', 'l'] : ['m'];
  const sizeIndex = preferred.indexOf(size);
  // Either preferred size wins over other sizes. Price breaks ties.
  const rank = sizeIndex < 0 ? 1 : 0;
  const parent = modelText(pick(record.item_group_id, record.parent_product_id));
  const model = modelText(pick(record.model_number, record.product_model));
  const pattern = modelText(record.pattern);
  const parts = modelText(name).split(/\s+-\s+/);
  let trimmed = false;
  while (parts.length > 1) {
    const suffix = parts.at(-1);
    if (!commonColours.has(suffix) && (!colour || suffix !== colour) &&
        (!size || suffix !== size && suffix !== 'taglia ' + size && suffix !== 'size ' + size)) break;
    parts.pop();
    trimmed = true;
  }
  // Cisalfa parent IDs can identify individual colours. Its titles explicitly
  // include the type and audience before a separate colour suffix.
  const cisTitle = /^cisalfa sport it$/i.test(merchant) && trimmed && parts.length >= 3;
  const identity = cisTitle || !model && !parent && (size || colour || trimmed)
    ? ['titolo', parts.join(' - ')]
    : model ? ['modello', model] : parent ? ['gruppo', parent] : null;
  return {
    rank,
    modelKey: identity && JSON.stringify([modelText(merchant), modelText(pick(record.brand_name, record.brand)),
      modelText(category), gender, pattern, ...identity])
  };
}

function offer(record, merchant, publisher, reject = () => null) {
  const name = pick(record.product_name, record.title);
  const availability = normalize(pick(record.availability, record.in_stock, record.stock_status));
  if (/^(?:0|no|false|out[ _-]?of[ _-]?stock|unavailable|esaurito|non disponibile|pre[ _-]?order)$/.test(availability)) return reject('non disponibili');
  const currency = pick(record.currency, record.currency_code);
  const current = [record.sale_price, record.search_price, record.store_price, record.price, record.display_price]
    .map(value => cents(value, currency)).find(value => value > 0);
  const image = https(pick(record.merchant_image_url, record.aw_image_url, record.image_link));
  const url = trackingLink(record, publisher);
  if (!name || !current || !image || !url) {
    return reject(...[!name && 'titolo mancante', !current && 'prezzo EUR non valido', !image && 'immagine HTTPS mancante',
      !url && 'link affiliato non verificabile'].filter(Boolean));
  }
  const rawGtin = pick(record.product_gtin, record.productgtin, record.ean, record.upc, record.gtin);
  const gtin = /^(?:\d{8}|\d{12,14})$/.test(rawGtin) && !/^0+$/.test(rawGtin) ? rawGtin.padStart(14, '0') : '';
  const originalPrice = [record.product_price_old, record.original_price, record.originalprice, record.previous_price,
    record.price_before_discount].map(value => cents(value, currency)).find(value => value > current);
  const referencePrice = [record.rrp_price, record.rrp, record.recommended_retail_price]
    .map(value => cents(value, currency)).find(value => value > current);
  const euro = value => (value / 100).toFixed(2).replace('.', ',');
  const variant = [record.colour || record.color, record['fashion:size'] || record.size].map(normalize);
  const key = gtin ? 'gtin:' + JSON.stringify([gtin, ...variant]) : 'offer:' + url;
  const category = pick(record.merchant_category, record.merchant_product_category_path, record.category_name, record.product_type)
    .split(/\s*>\s*/)[0] || 'Altri prodotti';
  const shipping = cents(record.delivery_cost, currency);
  return { key, current, shipping, name, price: euro(current), ...modelVariant(record, name, merchant, category),
    image: image.href, url, merchant, category, brand: pick(record.brand_name, record.brand),
    ...(originalPrice && { originalPrice: euro(originalPrice) }),
    ...(referencePrice && { referencePrice: euro(referencePrice) }) };
}

function cheapestOffers(offers) {
  const groups = new Map();
  for (const item of offers) {
    if (!groups.has(item.key)) groups.set(item.key, []);
    groups.get(item.key).push(item);
  }
  return [...groups.values()].map(group => {
    const withShipping = group.every(item => item.shipping !== null);
    const total = item => item.current + (withShipping ? item.shipping : 0);
    return group.reduce((best, item) => total(item) < total(best) ? item : best);
  });
}

function feedDigest(filename, buffer) {
  const hash = createHash('sha256');
  const file = fs.openSync(filename, 'r');
  try {
    let bytes;
    while ((bytes = fs.readSync(file, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(file);
  }
}

function main(repo, directory, publisher) {
  if (!repo || !directory || !/^\d+$/.test(publisher || '')) {
    throw new Error('Uso: node importa-listini-awin.cjs <repo> <LISTINI> <publisher-id>');
  }
  const walk = (folder) => fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith('.')) return [];
    const filename = path.join(folder, entry.name);
    if (entry.isDirectory()) return walk(filename);
    return entry.isFile() && sourceExtension.test(entry.name) ? [filename] : [];
  });
  const feeds = walk(directory).sort();
  if (!feeds.length) throw new Error('Nessun listino Awin da importare.');
  let totalValid = 0;
  const models = new Map();
  const seenFeeds = new Map();
  const hashBuffer = Buffer.allocUnsafe(256 * 1024);
  for (const filename of feeds) {
    const digest = feedDigest(filename, hashBuffer);
    if (seenFeeds.has(digest)) {
      console.log(path.relative(directory, filename) + ': copia identica di ' +
        path.relative(directory, seenFeeds.get(digest)) + '; salto la seconda importazione.');
      continue;
    }
    seenFeeds.set(digest, filename);
    let valid = 0;
    let invalid = 0;
    const reasons = new Map();
    const reject = (...causes) => {
      for (const cause of causes) reasons.set(cause, (reasons.get(cause) ?? 0) + 1);
      return null;
    };
    for (const row of records(filename, () => invalid++)) {
      const item = offer(row, pick(row.merchant_name, row.advertiser_name, path.basename(filename).replace(sourceExtension, '')), publisher, reject);
      if (item) {
        valid++;
        const key = item.modelKey ?? JSON.stringify([item.merchant, item.key]);
        const best = models.get(key);
        if (!best || item.rank < best.rank || item.rank === best.rank &&
            (item.current < best.current || item.current === best.current && item.url < best.url)) {
          // Retained CSV fields must not keep the entire decompressed string in memory.
          models.set(key, structuredClone(item));
        }
      }
    }
    if (!valid) {
      const details = [...reasons].map(([reason, count]) => reason + ': ' + count);
      if (invalid) details.push('righe malformate: ' + invalid);
      const issue = filename + ': nessuna offerta valida (' + (details.join('; ') || 'nessuna riga prodotto') + ')';
      if (invalid || process.env.SCALA_AWIN_SALTA_LISTINI_VUOTI !== '1') throw new Error(issue + '; catalogo precedente conservato.');
      console.warn('Listino escluso: ' + issue);
      continue;
    }
    totalValid += valid;
    console.log(path.relative(directory, filename) + ': ' + valid + ' offerte valide; ' + invalid + ' righe malformate.');
  }
  if (!models.size) throw new Error('Nessuna offerta valida nei listini; catalogo precedente conservato.');
  const discount = item => item.originalPrice ? 1 - item.current / cents(item.originalPrice, 'EUR') : 0;
  const products = cheapestOffers([...models.values()]).sort((a, b) => discount(b) - discount(a) || a.current - b.current);
  const output = path.join(repo, 'catalogo');
  const staging = fs.mkdtempSync(path.join(path.dirname(output), '.catalogo-'));
  try {
    const pages = [];
    for (let offset = 0; offset < products.length; offset += 500) {
      const entries = products.slice(offset, offset + 500).map(({ key, shipping, current, modelKey, rank, ...card }) => card);
      const content = JSON.stringify(entries);
      const file = createHash('sha256').update(content).digest('hex') + '.json';
      fs.writeFileSync(path.join(staging, file), content);
      pages.push({
        file, categories: [...new Set(entries.map(item => item.category))].sort(),
        merchants: [...new Set(entries.map(item => item.merchant).filter(Boolean))].sort()
      });
    }
    const manifest = {
      count: products.length, pages, categories: [...new Set(products.map(item => item.category))].sort(),
      merchants: [...new Set(pages.flatMap(page => page.merchants))].sort()
    };
    fs.writeFileSync(path.join(staging, 'indice.json'), JSON.stringify(manifest) + '\n');
    fs.mkdirSync(output, { recursive: true });
    for (const { file } of pages) fs.renameSync(path.join(staging, file), path.join(output, file));
    fs.renameSync(path.join(staging, 'indice.json'), path.join(output, 'indice.json'));
    const active = new Set(pages.map(page => page.file));
    for (const file of fs.readdirSync(output)) if (/^[a-f0-9]{64}\.json$/.test(file) && !active.has(file)) fs.unlinkSync(path.join(output, file));
    console.log(totalValid + ' varianti valide, ' + models.size + ' modelli selezionati prima del confronto tra venditori.');
    console.log(products.length + ' offerte pubblicabili in ' + pages.length + ' blocchi.');
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try { main(...process.argv.slice(2)); }
  catch (error) { console.error('Importazione interrotta: ' + error.message); process.exitCode = 1; }
}
