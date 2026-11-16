const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline/promises');
const { setTimeout: delay } = require('node:timers/promises');

const repository = 'https://github.com/davimarz/scaladeiturchi.git';
const publicSite = 'https://davimarz.github.io/scaladeiturchi/';
const rawBase = 'https://raw.githubusercontent.com/davimarz/archivioscarpe/';
const filesToPublish = ['catalogo'];
const feedExtension = /\.(?:(?:csv|tsv|jsonl|ndjson)(?:\.gz)?|gz)$/i;

const categories = [
  'Abbigliamento', 'Abbigliamento bambini', 'Abbigliamento femminile', 'Abbigliamento sportivo',
  'Abbigliamento uomo', 'Accessori Elettronica', 'Accessori abbigliamento', 'Acquisti di gruppo',
  'Attrezzature sportive', 'Audio-video', 'Auto e motori', 'Bambini e bebè', 'Biancheria intima',
  'Bricolage', 'Calzature', 'Casa e giardinaggio', 'Elettrodomestici', 'Entertainment Superstore',
  'Erotico', 'Forniture per ufficio', 'Fotografia', 'Gadget', 'Giochi', 'Gioielleria', 'Grandi magazzini',
  'Green (Eco friendly)', 'Informatica', 'Lead generation', 'Libri e abbonamenti', 'Mobili e Arredamento',
  'Musica e DVD', 'PC & Videogame', 'Prodotti Largo Consumo', 'Prodotti farmaceutici', 'Regali e fiori',
  'Salute e bellezza', 'Stampa e foto', 'Supermercati di elettronica', 'Veterinaria e animali',
  'Vini, alcolici e tabacchi',
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw new Error('Impossibile avviare ' + path.basename(command) + ': ' + result.error.code);
  if (result.status !== 0) {
    throw new Error(path.basename(command) + ' ha restituito un errore. Il dettaglio è riportato sopra.');
  }
}

async function downloadScript(revision, name, destination, category) {
  const response = await fetch(rawBase + revision + '/tools/awin/' + name, {
    redirect: 'error',
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error('Impossibile scaricare ' + name + ' da GitHub (HTTP ' + response.status + ')');
  let script = await response.text();
  const summary = "    console.log('Listini salvati: ' + completed + ' di ' + targets.length);";
  if (script.split(summary).length !== 2) throw new Error('Versione dello scaricatore Awin non riconosciuta.');
  const hook = 'const active = await readJoinedAdvertisers(page);';
  if (script.split(hook).length !== 2) throw new Error('Punto di selezione categoria Awin non riconosciuto.');
  const targetHook = 'const targets = requested.length ? active.filter(name => requested.includes(name.toLowerCase())) : active;';
  if (script.split(targetHook).length !== 2) throw new Error('Punto di selezione dei listini Awin non riconosciuto.');
  script = script.replace(hook, () => 'let selection; try { selection = await (' + readCategoryAdvertisers.toString() +
    ')(page, ' + JSON.stringify(category) + '); } catch (error) { console.error("Awin | " + error.message); process.exitCode = 1; return; }' +
    ' const active = selection.joined; if (!selection.targets.length) { console.log("Awin | Nessun advertiser iscritto nella categoria. Nessun listino scaricato."); process.exitCode = 1; return; }')
    .replace(targetHook, 'const targets = selection.targets;');
  // The shared downloader can exit successfully with only part of the batch.
  fs.writeFileSync(destination, script.replace(summary, summary +
    '\n    if (completed !== targets.length) process.exitCode = 1;'), { flag: 'wx' });
  run(process.execPath, ['--check', destination]);
}

function keepLocalFeeds(staging, local) {
  const feeds = fs.readdirSync(staging, { withFileTypes: true }).filter(entry => entry.isFile());
  if (!feeds.length || feeds.some(entry => !feedExtension.test(entry.name))) {
    throw new Error('Scaricamento incompleto o formato non supportato. Sono attesi CSV, TSV, gzip o JSONL.');
  }
  fs.mkdirSync(local, { recursive: true });
  for (const { name } of feeds) {
    const temporary = path.join(local, '.' + randomUUID() + '.part');
    try {
      fs.copyFileSync(path.join(staging, name), temporary, fs.constants.COPYFILE_EXCL);
      fs.renameSync(temporary, path.join(local, name));
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return feeds.length;
}

function publish(repo) {
  const git = (...args) => run('git', ['-C', repo, ...args]);
  git('add', '--', ...filesToPublish);
  const diff = spawnSync('git', ['-C', repo, 'diff', '--cached', '--quiet', '--', ...filesToPublish], { stdio: 'inherit' });
  if (diff.status === 0) {
    console.log('Il catalogo su GitHub è già identico.');
    return;
  }
  if (diff.status !== 1) throw new Error('Impossibile verificare le modifiche Git.');
  git('commit', '-m', 'Aggiorna catalogo offerte Awin', '--', ...filesToPublish);
  git('push', 'origin', 'HEAD:main');
}

async function verifyOnline(repo) {
  const hashes = new Map(['catalogo/indice.json'].map(name => [
    name, createHash('sha256').update(fs.readFileSync(path.join(repo, name))).digest('hex')
  ]));
  async function matches(name, expected) {
    try {
      const url = new URL(name, publicSite);
      url.searchParams.set('verifica', Date.now().toString());
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        await response.body?.cancel();
        return false;
      }
      const actual = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
      return actual === expected;
    } catch {
      return false;
    }
  }
  for (let attempt = 0; attempt < 12; attempt++) {
    const confirmed = await Promise.all([...hashes].map(([name, expected]) => matches(name, expected)));
    if (confirmed.every(Boolean)) return true;
    if (attempt < 11) await delay(10000);
  }
  return false;
}

// The public directory exposes the category tree. Only programs already joined
// in Advertiser personali may become download targets.
async function readCategoryAdvertisers(page, category) {
  const normalize = name => name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  const joined = await readJoinedAdvertisers(page);
  if (!joined.length) throw new Error('Non riesco a verificare gli Advertiser personali.');
  const joinedByName = new Map(joined.map(name => [normalize(name), name]));
  console.log('Awin | Advertiser personali rilevati: ' + joinedByName.size + '. Verifico la categoria nella scheda generale.');

  const allText = /^Tutti gli advertiser$/i;
  const allTab = page.getByRole('tab', { name: allText })
    .or(page.getByRole('link', { name: allText })).or(page.getByRole('button', { name: allText }));
  const tab = allTab.filter({ visible: true });
  if (await tab.count() === 1) await tab.click({ timeout: 5000 }).catch(() => {});
  else {
    const textTab = page.getByText(allText).filter({ visible: true });
    if (await textTab.count() === 1) await textTab.click({ timeout: 5000 }).catch(() => {});
  }
  const snapshot = () => page.evaluate(() => {
    const clean = value => (value ?? '').replace(/\s+/g, ' ').trim();
    const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
    const heading = [...document.querySelectorAll('body *')].find(node =>
      visible(node) && /^Tutti gli advertiser\s*\(\s*[\d.]+\s*\)$/i.test(clean(node.textContent)) &&
      ![...node.children].some(child => child.textContent.trim() === node.textContent.trim() && visible(child)));
    if (!heading) return null;
    const total = Number(clean(heading.textContent).match(/\(\s*([\d.]+)\s*\)/)[1].replaceAll('.', ''));
    if (!Number.isSafeInteger(total)) return null;
    if (total === 0) return { total, names: [] };
    for (let scope = heading.parentElement; scope; scope = scope.parentElement) {
      const table = [...scope.querySelectorAll('table, [role="table"], [role="grid"]')].find(candidate =>
        visible(candidate) && (heading.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        [...candidate.querySelectorAll('th, [role="columnheader"]')].some(cell => /^advertiser$/i.test(clean(cell.innerText))));
      if (!table) continue;
      const names = [...table.querySelectorAll('tr, [role="row"]')].filter(visible).map(row => {
        const cell = [...row.children].find(node => node.matches('td, [role="cell"], [role="gridcell"]'));
        return clean(cell?.innerText).replace(/\s*\((?:iscritt[oi]|non iscritt[oi]|in attesa|invit[oa]|rifiutat[oi]|sospes[oi]|chius[oi])\)\s*$/i, '');
      }).filter(name => name && !/^advertiser$/i.test(name));
      if (names.length) return { total, names };
    }
    return null;
  });
  async function stableRows(accept, message, timeout = 25000) {
    const until = Date.now() + timeout;
    let signature, since;
    while (Date.now() < until) {
      const rows = await snapshot();
      const key = JSON.stringify(rows);
      if (!rows || !await accept(rows)) signature = undefined;
      else if (signature !== key) { signature = key; since = Date.now(); }
      else if (Date.now() - since >= 1200) return rows;
      await page.waitForTimeout(250);
    }
    throw new Error(message);
  }
  const allHeading = page.getByText(/^Tutti gli advertiser\s*\(/i).filter({ visible: true }).first();
  if (!await allHeading.isVisible()) {
    console.log('Awin | Se serve, apri «Tutti gli advertiser» nel browser. Non selezionare ancora la categoria.');
    await allHeading.waitFor({ timeout: 90000 }).catch(() => {
      throw new Error('La scheda «Tutti gli advertiser» non è stata confermata. Nessun listino scaricato.');
    });
  }
  const sector = page.getByText('Retail & Shopping', { exact: true }).filter({ visible: true });
  await sector.waitFor({ timeout: 15000 });
  const sectorItem = sector.locator('xpath=ancestor-or-self::li[1]');
  const label = page.getByText(category, { exact: true }).filter({ visible: true });
  const toggle = sectorItem.locator(':scope > .hitarea, :scope > [aria-expanded="false"], :scope > :not(ul) > [aria-expanded="false"]')
    .filter({ visible: true });
  if (!await label.isVisible() && await toggle.count() === 1) {
    await toggle.click({ timeout: 3500 }).catch(() => {});
    await label.waitFor({ timeout: 4000 }).catch(() => {});
  }
  if (!await label.isVisible()) {
    console.log('Awin | In «Tutti gli advertiser», apri Retail & Shopping usando la freccia. Lascia la categoria deselezionata.');
    await label.waitFor({ timeout: 90000 }).catch(() => {
      throw new Error('La sottocategoria «' + category + '» non è visibile nemmeno in «Tutti gli advertiser». Nessun listino scaricato.');
    });
  }
  const item = label.locator('xpath=ancestor-or-self::li[1]');
  const selection = () => item.evaluate(target => {
    const subgroup = target.closest('ul');
    const parent = subgroup?.closest('li');
    const tree = parent?.closest('ul');
    const caption = parent && [...parent.children].filter(node => node !== subgroup)
      .map(node => node.textContent?.trim()).filter(Boolean).join(' ');
    if (!tree || !/^Retail & Shopping$/i.test(caption ?? '')) return { valid: false };
    const checked = node => !node.classList.contains('indeterminate') &&
      (node.classList.contains('selected') || node.matches('[aria-checked="true"]') ||
       !!node.querySelector(':scope > :is(input:checked,[aria-checked="true"]), :scope > :is(label,span,div) > :is(input:checked,[aria-checked="true"])'));
    return { valid: true, selected: checked(target), other: [...tree.querySelectorAll('li')].some(node => node !== target && checked(node)) };
  });
  const initial = await selection();
  if (!initial.valid || initial.other) throw new Error('I controlli di categoria non sono verificabili o ci sono altri settori selezionati.');
  if (initial.selected) await label.click();
  const unfiltered = await stableRows(async () => {
    const state = await selection();
    return state.valid && !state.selected && !state.other;
  }, 'Elenco generale iniziale non verificabile.');
  await label.click();
  const categoryOnly = async () => {
    const state = await selection();
    return state.valid && state.selected && !state.other;
  };
  let current = await stableRows(rows => rows.total < unfiltered.total ? categoryOnly() : false,
    'Awin non ha confermato un elenco più ristretto per «' + category + '». Nessun listino scaricato.');
  const expected = current.total;
  const seen = new Set();
  const names = new Set();
  while (names.size < expected) {
    if (!await categoryOnly()) throw new Error('Il filtro di categoria è cambiato durante la lettura.');
    const key = JSON.stringify(current.names);
    if (seen.has(key)) throw new Error('Awin ha ripetuto una pagina della categoria.');
    seen.add(key);
    for (const name of current.names) names.add(normalize(name));
    if (names.size === expected) break;
    if (names.size > expected) throw new Error('Il totale della categoria non corrisponde alle righe.');
    const nextLabel = /^(?:pagina )?successiv[ao](?:\s*[›»])?$/i;
    const next = page.getByRole('link', { name: nextLabel }).or(page.getByRole('button', { name: nextLabel }))
      .or(page.getByText(nextLabel)).filter({ visible: true }).first();
    if (!await next.isVisible() || !await next.isEnabled()) throw new Error('Non riesco a leggere tutte le pagine della categoria.');
    await next.click();
    current = await stableRows(rows =>
      rows.total === expected && JSON.stringify(rows.names) !== key ? categoryOnly() : false,
    'La pagina successiva della categoria non è stata confermata.');
  }
  const targets = [...names].filter(name => joinedByName.has(name)).map(name => joinedByName.get(name));
  console.log('Awin | ' + category + ': ' + names.size + ' programmi nella categoria, ' + targets.length + ' nei tuoi Advertiser personali.');
  return { joined, targets };
}

function categoryChoice(input) {
  const number = input.trim();
  if (number === '0') return null;
  if (!/^[1-9]\d*$/.test(number) || Number(number) > categories.length) {
    throw new Error('Scegli un numero da 0 a ' + categories.length + '.');
  }
  return categories[Number(number) - 1];
}

async function chooseCategory() {
  console.log('0. Aggiorna il catalogo con tutti i listini già salvati');
  categories.forEach((name, i) => console.log((i + 1) + '. ' + name));
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return categoryChoice(await prompt.question('Scegli la sottocategoria da scaricare: ')); }
  finally { prompt.close(); }
}

async function main() {
  const [choice, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Uso: node aggiorna-scala-dei-turchi.cjs [numero sottocategoria]');
  const category = choice === undefined ? await chooseCategory() : categoryChoice(choice);
  const publisher = '3150312';
  const local = path.join(__dirname, 'LISTINI');
  const working = fs.mkdtempSync(path.join(os.tmpdir(), 'scala-awin-'));
  const staging = path.join(working, 'listini');
  const repo = path.join(working, 'sito');
  const downloadPath = path.join(__dirname, '.scarica-awin-' + randomUUID() + '.cjs');
  let preserveWorking = false;
  try {
    if (category) {
      fs.mkdirSync(staging);
      await downloadScript('a4bf3cc0ebecadc7450c6180d42a2d2af6407bc2', 'scarica-listini-awin.cjs', downloadPath, category);
      console.log('Scarico i listini Awin degli advertiser attivi: ' + category);
      try {
        run(process.execPath, [downloadPath, publisher], { env: { ...process.env, AWIN_LISTINI_DIR: staging } });
        const destination = path.join(local, category);
        const count = keepLocalFeeds(staging, destination);
        console.log('Listini aggiornati: ' + count + ' | ' + destination);
      } catch (error) {
        if (fs.readdirSync(staging).some(name => feedExtension.test(name))) {
          preserveWorking = true;
          console.error('Download incompleto. Listini parziali conservati qui: ' + staging);
        }
        throw error;
      }
    }
    if (!fs.existsSync(local)) throw new Error('Cartella listini non trovata: ' + local);
    console.log('Aggiorno il catalogo con tutti i listini e le sottocartelle di ' + local);
    run('git', ['clone', '--depth', '1', '--single-branch', '--branch', 'main', repository, repo]);
    run(process.execPath, [path.join(repo, 'tools', 'awin', 'importa-listini-awin.cjs'), repo, local, publisher]);
    publish(repo);
    if (!await verifyOnline(repo)) {
      console.warn('GitHub aggiornato, ma il nuovo catalogo non è ancora verificabile su GitHub Pages.');
      process.exitCode = 2;
      return;
    }
    console.log('Catalogo verificato online: ' + publicSite);
  } finally {
    fs.rmSync(downloadPath, { force: true });
    if (!preserveWorking) fs.rmSync(working, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('Aggiornamento interrotto: ' + error.message);
  process.exitCode = 1;
});
