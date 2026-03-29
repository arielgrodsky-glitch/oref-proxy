const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3000;

// Twilio — set all of these in Render environment variables
const TWILIO_SID        = process.env.TWILIO_SID;
const TWILIO_API_KEY    = process.env.TWILIO_API_KEY;
const TWILIO_API_SECRET = process.env.TWILIO_API_SECRET;
const TWILIO_FROM       = process.env.TWILIO_FROM;
const SMS_TO            = process.env.SMS_TO || '+972542574433';

const OREF_HEADERS = {
  'Pragma': 'no-cache',
  'Cache-Control': 'no-cache',
  'Referer': 'https://www.oref.org.il/',
  'Origin': 'https://www.oref.org.il',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-cache, no-store',
};

function fetchOref(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: OREF_HEADERS }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (!buffer.length) return resolve('');

        let encoding = 'utf8';
        let data = buffer;

        if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
          encoding = 'utf16le';
          data = buffer.slice(2);
        } else if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
          data = buffer.slice(3);
        }

        let text = data.toString(encoding);
        text = text.replace(/\x00/g, '').replace(/\u0A7B/g, '').trim();
        resolve(text);
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Send SMS via Twilio REST API (API Key auth) ──
function sendSms(body) {
  return new Promise((resolve, reject) => {
    if (!TWILIO_SID || !TWILIO_API_KEY || !TWILIO_API_SECRET) {
      return reject(new Error('Twilio credentials not set in environment variables'));
    }

    const payload = new URLSearchParams({
      To:   SMS_TO,
      From: TWILIO_FROM,
      Body: body,
    }).toString();

    const auth = Buffer.from(`${TWILIO_API_KEY}:${TWILIO_API_SECRET}`).toString('base64');

    const options = {
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`✅ SMS sent to ${SMS_TO}`);
          resolve({ ok: true });
        } else {
          console.error(`❌ Twilio error ${res.statusCode}: ${text}`);
          reject(new Error(`Twilio ${res.statusCode}: ${text}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Twilio timeout')); });
    req.write(payload);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch(e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  const url = req.url.split('?')[0];

  if (url === '/' || url === '/health') {
    res.writeHead(200, CORS_HEADERS);
    return res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
  }

  if (url === '/alerts') {
    try {
      const ts = Math.round(Date.now() / 1000);
      const text = await fetchOref(`https://www.oref.org.il/warningMessages/alert/Alerts.json?${ts}`);
      res.writeHead(200, CORS_HEADERS);
      if (!text) return res.end(JSON.stringify({ id: null, cat: null, title: '', data: [] }));
      return res.end(text);
    } catch (e) {
      console.error('Alerts fetch error:', e.message);
      res.writeHead(500, CORS_HEADERS);
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url === '/history') {
    try {
      const ts = Math.round(Date.now() / 1000);
      const text = await fetchOref(`https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json?${ts}`);
      res.writeHead(200, CORS_HEADERS);
      if (!text) return res.end('[]');
      return res.end(text);
    } catch (e) {
      console.error('History fetch error:', e.message);
      res.writeHead(500, CORS_HEADERS);
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url === '/send-sms' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const title = body.title || 'Alert';
      const areas = Array.isArray(body.areas) ? body.areas : [];
      const msg = `${title}\n${areas.join(', ')}\n${new Date().toLocaleTimeString('he-IL')}`;

      await sendSms(msg);

      res.writeHead(200, CORS_HEADERS);
      return res.end(JSON.stringify({ ok: true, message: 'SMS sent via Twilio' }));
    } catch (e) {
      console.error('SMS error:', e.message);
      res.writeHead(500, CORS_HEADERS);
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  res.writeHead(404, CORS_HEADERS);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`✅ Oref proxy running on http://localhost:${PORT}`);
  console.log(`   /alerts   → live active alerts`);
  console.log(`   /history  → last ~2 hours of alerts`);
  console.log(`   /send-sms → SMS to ${SMS_TO} via Twilio`);
  if (!TWILIO_SID) console.warn('⚠️  Twilio credentials not set!');
});