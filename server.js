const express = require('express');
const cors = require('cors');
const MetaApi = require('metaapi.cloud-sdk').default;

const { METAAPI_TOKEN, METAAPI_ACCOUNT_ID, APP_PASSWORD } = process.env;
if (!METAAPI_TOKEN || !METAAPI_ACCOUNT_ID || !APP_PASSWORD) {
  console.error('Missing METAAPI_TOKEN, METAAPI_ACCOUNT_ID or APP_PASSWORD');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (req.get('x-app-password') !== APP_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  next();
});

const bots = {};
let maxDailyLossPct = 3;
let dayStart = { date: '', equity: 0 };
let conn = null;

async function getConn() {
  if (conn) return conn;
  const api = new MetaApi(METAAPI_TOKEN);
  const account = await api.metatraderAccountApi.getAccount(METAAPI_ACCOUNT_ID);
  if (account.state !== 'DEPLOYED') await account.deploy();
  await account.waitConnected();
  const c = account.getRPCConnection();
  await c.connect();
  await c.waitSynchronized();
  conn = c;
  return conn;
}

async function closeAll() {
  const c = await getConn();
  const positions = await c.getPositions();
  for (const p of positions) await c.closePosition(p.id);
  return positions.length;
}

function stopAllBots() { Object.keys(bots).forEach(k => (bots[k] = false)); }

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/status', async (req, res) => {
  try {
    const c = await getConn();
    const [info, positions] = await Promise.all([c.getAccountInformation(), c.getPositions()]);
    res.json({
      balance: info.balance, equity: info.equity, currency: info.currency, server: info.server,
      positions: positions.map(p => ({ id: p.id, symbol: p.symbol, type: p.type, volume: p.volume, profit: p.profit })),
      bots, maxDailyLossPct
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/bots/:name/:action', (req, res) => {
  if (!['start', 'stop'].includes(req.params.action)) return res.status(400).json({ error: 'Use start or stop' });
  bots[req.params.name] = req.params.action === 'start';
  res.json({ bots });
});

app.post('/stop-all', async (req, res) => {
  try { stopAllBots(); const n = await closeAll(); res.json({ stopped: true, closed: n }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/close-all', async (req, res) => {
  try { res.json({ closed: await closeAll() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/risk', (req, res) => {
  const v = Number(req.body.maxDailyLossPct);
  if (!(v > 0 && v <= 50)) return res.status(400).json({ error: 'Enter a number between 0 and 50' });
  maxDailyLossPct = v;
  res.json({ maxDailyLossPct });
});

setInterval(async () => {
  try {
    if (!conn) return;
    const info = await conn.getAccountInformation();
    const today = new Date().toISOString().slice(0, 10);
    if (dayStart.date !== today) dayStart = { date: today, equity: info.equity };
    const lossPct = ((dayStart.equity - info.equity) / dayStart.equity) * 100;
    if (lossPct >= maxDailyLossPct) {
      console.log('Daily loss limit hit, stopping all');
      stopAllBots(); await closeAll();
    }
  } catch (e) { console.error('Risk check failed:', e.message); }
}, 30000);

app.listen(process.env.PORT || 3000, () => console.log('Yazan server running'));
