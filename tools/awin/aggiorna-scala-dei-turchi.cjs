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
  script = script.replace(hook, () => 'const active = await (' + readCategoryAdvertisers.toString() + ')(page, ' + JSON.stringify(category) + ').catch(error => { console.error(error.message); throw error; });');
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

// Runs inside the pinned downloader, reusing its authenticated active-directory browser.
async function readCategoryAdvertisers(page, category) {
  const sector = page.getByText('Retail & Shopping', { exact: true }).filter({ visible: true });
  await sector.waitFor();
  const branch = sector.locator('xpath=ancestor-or-self::li[./ul][1]');
  const label = branch.getByText(category, { exact: true });
  if (!await label.isVisible()) {
    const toggle = branch.locator(':scope > .hitarea, :scope > [aria-expanded="false"]').filter({ visible: true });
    if (await toggle.count() !== 1) throw new Error('Ramo Retail & Shopping non apribile.');
    await toggle.click();
  }
  await label.waitFor();
  const item = label.locator('xpath=ancestor-or-self::li[contains(concat(" ", normalize-space(@class), " "), " checkbox ")][1]');
  const checked = () => item.evaluate(node => node.classList.contains('selected') ||
    Boolean(node.querySelector(':scope > input:checked, :scope > [aria-checked="true"]')));
  if (!await checked()) {
    const before = await page.evaluate(inspectPersonalAdvertisers, false);
    await label.click();
    const until = Date.now() + 12000;
    let changed = false;
    while (Date.now() < until) {
      const after = await page.evaluate(inspectPersonalAdvertisers, false);
      if (after.names?.length && JSON.stringify(after) !== JSON.stringify(before) && await checked()) {
        changed = true;
        break;
      }
      await page.waitForTimeout(250);
    }
    if (!changed) throw new Error('Risultati della categoria non verificabili o nessun advertiser attivo: ' + category);
  }
  const names = new Set();
  const visited = new Set();
  let expected;
  for (;;) {
    if (!await checked()) throw new Error('Awin ha perso il filtro: ' + category);
    const extra = await item.evaluate(target => [...target.closest('ul').querySelectorAll('li.checkbox')]
      .some(node => node !== target && !node.contains(target) && (node.classList.contains('selected') ||
        node.querySelector(':scope > input:checked, :scope > [aria-checked="true"]'))));
    if (extra) throw new Error('Sono selezionate più sottocategorie: ' + category);
    const current = await readAdvertiserPage(page);
    if (!current.names.length || !await checked()) throw new Error('Elenco filtrato non verificabile: ' + category);
    expected ??= current.total;
    if (current.total !== expected) throw new Error('Il numero di advertiser filtrati è cambiato.');
    const signature = JSON.stringify(current.names);
    if (visited.has(signature)) throw new Error('Awin ha ripetuto una pagina.');
    visited.add(signature);
    for (const name of current.names) names.add(name);
    const nextLabel = /^(?:pagina )?successiv[ao](?:\s*[›»])?$/i;
    const next = page.getByRole('link', { name: nextLabel }).or(page.getByRole('button', { name: nextLabel }))
      .or(page.getByText(nextLabel)).filter({ visible: true });
    if (expected !== null && names.size === expected) return [...names];
    if (await next.count() !== 1 || !await next.isEnabled()) {
      if (expected === null && await next.count() === 0) return [...names];
      throw new Error('Paginazione filtrata non verificabile.');
    }
    await next.click();
    const until = Date.now() + 12000;
    for (;;) {
      const after = await page.evaluate(inspectPersonalAdvertisers, false);
      if (!await checked()) throw new Error('Il filtro è stato perso passando alla pagina successiva.');
      if (after.names?.length && JSON.stringify(after.names) !== signature) break;
      if (Date.now() >= until) throw new Error('La pagina successiva non si è caricata.');
      await page.waitForTimeout(250);
    }
  }
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
