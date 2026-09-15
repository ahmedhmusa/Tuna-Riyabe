# Island Tuna

Offline-first business management app for a small island tuna and seafood business.
Fresh tuna buying and selling, customer credit, dried tuna and Rihaakuru production,
inventory, expenses and reports. All data stays on your device.

## Put it online with GitHub Pages (free)

You only need a GitHub account. No installing anything.

### 1. Create the repository
1. Go to **github.com** and sign in (create a free account if you don't have one).
2. Click the **+** in the top right → **New repository**.
3. Name it `island-tuna`.
4. Choose **Public**.
5. Click **Create repository**.

### 2. Upload the files
1. On the new empty repository page, click **uploading an existing file**.
2. Drag in **all six files** from this folder:
   - `index.html`
   - `styles.css`
   - `app.js`
   - `manifest.json`
   - `sw.js`
   - `icon.svg`
3. Scroll down and click **Commit changes**.

> Upload the files themselves, not the folder or the zip.
> `index.html` must sit at the top level of the repository.

### 3. Turn on GitHub Pages
1. In the repository, click **Settings** (top bar).
2. In the left sidebar, click **Pages**.
3. Under **Branch**, select **main**, keep the folder as **/ (root)**, click **Save**.
4. Wait about a minute, then refresh the page. Your link appears at the top:

   `https://YOUR-USERNAME.github.io/island-tuna/`

### 4. Open and install it
- Open that link on your phone.
- **iPhone (Safari):** Share button → **Add to Home Screen**.
- **Android (Chrome):** menu **⋮** → **Install app**.

It now opens like a normal app, works with no internet, and keeps your data
on the device.

## Making changes later
Edit a file directly on GitHub (open the file → pencil icon → **Commit changes**),
or upload a replacement file. The live site updates within a minute.

If you don't see your change, close and reopen the app — the service worker
caches files for offline use and may serve the old version once.

## Your data
Everything is stored in your browser's own database on that device. It is not
uploaded anywhere, and it is not shared between phones.

**Back up regularly:** open **More → Backup & Restore → Export Full Backup**
and keep the `.json` file somewhere safe. You will need it if you clear your
browser data, switch phones, or lose the device. You can also export CSV files
for sales, purchases, credit and inventory.

## What's inside
- **Home** — today's sales, purchases, expenses, stock, outstanding credit, estimated profit
- **Sales** — fast fresh tuna sale, plus multi-item sales for packs and bottles
- **Purchases** — buying from fishermen, with supplier balances
- **Inventory** — fresh tuna in kg, dried tuna packs, Rihaakuru bottles, low-stock warnings, full movement history
- **Customers** — profiles, running credit ledger, payments, credit limits, payment reminders
- **Credit** — total outstanding, aging buckets, sorting by balance or age
- **Production** — dried tuna and Rihaakuru batches with cost per unit
- **Products** — pack sizes, prices, stock levels
- **Expenses** — categorised daily costs
- **Reports** — daily, weekly and monthly totals, product breakdown, top customers
- **Backup & Restore** — full JSON backup, restore, CSV exports
- **Settings** — business details, default prices, thresholds, dark mode

Prices, currency and business details are all editable in Settings.
