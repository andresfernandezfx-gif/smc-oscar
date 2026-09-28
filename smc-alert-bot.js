/**
 * SMC - Oscar FX · Alert Bot (Node.js)
 * Corre en GitHub Actions cada X minutos sin necesidad de navegador.
 *
 * Secrets requeridos:
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID
 * Opcionales:
 *   OANDA_API_TOKEN   (practice o live)
 *   OANDA_ENV         (practice | live) default practice
 *   PAIRS             (ej: EURUSD,GBPUSD,XAUUSD)
 *   TIMEFRAME         (15m | 1h | 4h) default 15m
 *   MIN_SCORE         default 70
 */

const https = require('https');
const http = require('http');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const OANDA_API_TOKEN = process.env.OANDA_API_TOKEN || '';
const OANDA_ENV = (process.env.OANDA_ENV || 'practice').toLowerCase();
const PAIRS = (process.env.PAIRS || 'EURUSD,GBPUSD,XAUUSD')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const TIMEFRAME = process.env.TIMEFRAME || '15m';
const MIN_SCORE = Number(process.env.MIN_SCORE || 70);

function fetchJson(url, headers) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: headers || {}, timeout: 20000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error('HTTP ' + res.statusCode + ' ' + data.slice(0, 120)));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function oandaInstrument(pair) {
  if (pair === 'XAUUSD') return 'XAU_USD';
  if (pair.length === 6) return pair.slice(0, 3) + '_' + pair.slice(3);
  return pair;
}

function oandaGranularity(tf) {
  if (tf === '5m') return 'M5';
  if (tf === '15m') return 'M15';
  if (tf === '1h') return 'H1';
  if (tf === '4h') return 'H4';
  return 'H1';
}

async function fetchOandaCandles(pair, tf, count) {
  if (!OANDA_API_TOKEN) return null;
  const host =
    OANDA_ENV === 'live' ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com';
  const url =
    host +
    '/v3/instruments/' +
    encodeURIComponent(oandaInstrument(pair)) +
    '/candles?granularity=' +
    oandaGranularity(tf) +
    '&count=' +
    (count || 120) +
    '&price=M';
  const json = await fetchJson(url, {
    Authorization: 'Bearer ' + OANDA_API_TOKEN,
    Accept: 'application/json',
  });
  if (!json.candles || !json.candles.length) return null;
  return json.candles
    .filter((c) => c.mid)
    .map((c) => ({
      time: Math.floor(new Date(c.time).getTime() / 1000),
      open: +c.mid.o,
      high: +c.mid.h,
      low: +c.mid.l,
      close: +c.mid.c,
    }));
}

function yahooSymbol(pair) {
  if (pair === 'XAUUSD') return 'GC=F';
  return pair + '=X';
}

function yahooInterval(tf) {
  if (tf === '15m') return { interval: '15m', range: '10d' };
  if (tf === '1h') return { interval: '60m', range: '1mo' };
  if (tf === '4h') return { interval: '60m', range: '3mo' };
  return { interval: '15m', range: '10d' };
}

async function fetchYahooCandles(pair, tf) {
  const ir = yahooInterval(tf);
  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(yahooSymbol(pair)) +
    '?interval=' +
    ir.interval +
    '&range=' +
    ir.range;
  const json = await fetchJson(url, { 'User-Agent': 'Mozilla/5.0 SMC-Oscar-Bot' });
  const res = json.chart && json.chart.result && json.chart.result[0];
  if (!res || !res.timestamp) return null;
  const q = res.indicators.quote[0];
  const out = [];
  for (let i = 0; i < res.timestamp.length; i++) {
    if (q.close[i] == null) continue;
    out.push({
      time: res.timestamp[i],
      open: +q.open[i],
      high: +q.high[i],
      low: +q.low[i],
      close: +q.close[i],
    });
  }
  if (tf === '4h') {
    // aggregate 1h -> 4h rough
    const agg = [];
    for (let i = 0; i < out.length; i += 4) {
      const chunk = out.slice(i, i + 4);
      if (!chunk.length) continue;
      agg.push({
        time: chunk[0].time,
        open: chunk[0].open,
        high: Math.max(...chunk.map((c) => c.high)),
        low: Math.min(...chunk.map((c) => c.low)),
        close: chunk[chunk.length - 1].close,
      });
    }
    return agg;
  }
  return out;
}

async function fetchCandles(pair, tf) {
  try {
    const o = await fetchOandaCandles(pair, tf, 120);
    if (o && o.length > 30) return { candles: o, source: 'OANDA' };
  } catch (e) {
    console.warn('OANDA fail', pair, e.message);
  }
  try {
    const y = await fetchYahooCandles(pair, tf);
    if (y && y.length > 30) return { candles: y, source: 'Yahoo' };
  } catch (e) {
    console.warn('Yahoo fail', pair, e.message);
  }
  return null;
}

function atr(candles, len) {
  len = len || 14;
  if (candles.length < len + 1) return 0;
  let sum = 0;
  for (let i = candles.length - len; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    sum += tr;
  }
  return sum / len;
}

function swings(candles, left, right) {
  left = left || 3;
  right = right || 3;
  const out = [];
  for (let i = left; i < candles.length - right; i++) {
    let isH = true;
    let isL = true;
    for (let k = i - left; k <= i + right; k++) {
      if (k === i) continue;
      if (candles[k].high >= candles[i].high) isH = false;
      if (candles[k].low <= candles[i].low) isL = false;
    }
    if (isH) out.push({ kind: 'H', idx: i, price: candles[i].high });
    if (isL) out.push({ kind: 'L', idx: i, price: candles[i].low });
  }
  return out;
}

function analyze(candles) {
  if (!candles || candles.length < 40) return null;
  const a = atr(candles, 14);
  const sw = swings(candles, 3, 3);
  const highs = sw.filter((s) => s.kind === 'H');
  const lows = sw.filter((s) => s.kind === 'L');
  if (highs.length < 2 || lows.length < 2) return null;

  const last = candles[candles.length - 1];
  const px = last.close;
  const recent = sw.slice(-8);
  let hh = 0,
    hl = 0,
    lh = 0,
    ll = 0;
  for (let i = 1; i < recent.length; i++) {
    const p = recent[i - 1];
    const c = recent[i];
    if (c.kind === 'H' && p.kind === 'H') {
      if (c.price > p.price) hh++;
      else lh++;
    }
    if (c.kind === 'L' && p.kind === 'L') {
      if (c.price > p.price) hl++;
      else ll++;
    }
  }
  let bias = 'NEUTRAL';
  if (hh + hl > lh + ll + 1) bias = 'BULLISH';
  if (lh + ll > hh + hl + 1) bias = 'BEARISH';

  const rh = Math.max(...highs.slice(-4).map((s) => s.price));
  const rl = Math.min(...lows.slice(-4).map((s) => s.price));
  if (!(rh > rl)) return null;
  const eq = (rh + rl) / 2;
  const zone = px > eq ? 'PREMIUM' : px < eq ? 'DISCOUNT' : 'EQUILIBRIUM';

  // último BOS aproximado por cierre más allá del swing
  let lastBos = null;
  const lastH = highs[highs.length - 1];
  const lastL = lows[lows.length - 1];
  for (let i = candles.length - 8; i < candles.length; i++) {
    if (lastH && candles[i].close > lastH.price) lastBos = { dir: 'up', price: lastH.price };
    if (lastL && candles[i].close < lastL.price) lastBos = { dir: 'down', price: lastL.price };
  }

  let score = 40;
  if (bias === 'BULLISH' && zone === 'DISCOUNT') score += 25;
  if (bias === 'BEARISH' && zone === 'PREMIUM') score += 25;
  if (bias !== 'NEUTRAL') score += 10;
  if (lastBos && ((bias === 'BULLISH' && lastBos.dir === 'up') || (bias === 'BEARISH' && lastBos.dir === 'down')))
    score += 15;

  // Setup sniper simple
  let dir = null;
  let entry = null;
  let sl = null;
  let tp = null;
  if (bias === 'BULLISH' && zone === 'DISCOUNT') {
    dir = 'LONG';
    entry = rl + (eq - rl) * 0.5; // zona media discount
    sl = rl - a * 0.25;
    tp = rh;
  } else if (bias === 'BEARISH' && zone === 'PREMIUM') {
    dir = 'SHORT';
    entry = eq + (rh - eq) * 0.5;
    sl = rh + a * 0.25;
    tp = rl;
  }

  let rr = null;
  if (dir && entry && sl && tp) {
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    rr = risk > 0 ? reward / risk : 0;
    if (rr < 1.5) score -= 20;
    else score += 10;
  }

  return {
    bias,
    zone,
    score: Math.max(0, Math.min(100, score)),
    dir,
    entry,
    sl,
    tp,
    rr,
    rh,
    rl,
    eq,
    price: px,
  };
}

function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('Telegram secrets missing');
    return Promise.resolve(false);
  }
  const url =
    'https://api.telegram.org/bot' +
    TELEGRAM_BOT_TOKEN +
    '/sendMessage?chat_id=' +
    encodeURIComponent(TELEGRAM_CHAT_ID) +
    '&text=' +
    encodeURIComponent(text);
  return fetchJson(url)
    .then((j) => !!j.ok)
    .catch((e) => {
      console.warn('Telegram error', e.message);
      return false;
    });
}

function fmt(pair, n) {
  if (n == null || isNaN(n)) return '—';
  const d = pair.indexOf('JPY') >= 0 || pair === 'XAUUSD' ? 2 : 5;
  return Number(n).toFixed(d);
}

async function run() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID');
    process.exit(1);
  }
  console.log('Pairs:', PAIRS.join(', '), 'TF:', TIMEFRAME, 'MinScore:', MIN_SCORE);
  const alerts = [];
  for (const pair of PAIRS) {
    try {
      const data = await fetchCandles(pair, TIMEFRAME);
      if (!data) {
        console.log(pair, 'sin datos');
        continue;
      }
      const sig = analyze(data.candles);
      if (!sig) {
        console.log(pair, 'sin señal', data.source);
        continue;
      }
      console.log(
        pair,
        data.source,
        'bias=' + sig.bias,
        'zone=' + sig.zone,
        'score=' + sig.score,
        sig.dir || '—'
      );
      if (sig.score < MIN_SCORE || !sig.dir) continue;
      const msg =
        'SMC Oscar Bot · ' +
        pair +
        ' ' +
        TIMEFRAME +
        '\n' +
        (sig.dir === 'LONG' ? 'LONG' : 'SHORT') +
        ' | E ' +
        fmt(pair, sig.entry) +
        ' | SL ' +
        fmt(pair, sig.sl) +
        ' | TP ' +
        fmt(pair, sig.tp) +
        '\nScore ' +
        sig.score +
        (sig.rr ? ' | R:R 1:' + sig.rr.toFixed(1) : '') +
        '\nBias ' +
        sig.bias +
        ' | ' +
        sig.zone +
        ' | Px ' +
        fmt(pair, sig.price) +
        '\nFuente: ' +
        data.source;
      alerts.push(msg);
    } catch (e) {
      console.warn(pair, e.message);
    }
  }
  if (!alerts.length) {
    console.log('Sin alertas en este ciclo');
    return;
  }
  for (const msg of alerts) {
    const ok = await sendTelegram(msg);
    console.log('Telegram', ok ? 'OK' : 'FAIL', msg.split('\n')[0]);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
