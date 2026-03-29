const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3000;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'groariel@gmail.com';
const GMAIL = 'groariel@gmail.com';
const SMS_GATEWAY = '0542574433@partner.net.il';

const OREF_HEADERS = {
  'Pragma': 'no-cache',
  'Cache-Control': 'max-age=0',
  'Referer': 'https://www.oref.org.il/11226-he/pakar.aspx',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'he-IL,he;q=0.9',
  'Connection': 'keep-alive',
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

// ── Send to one recipient via SendGrid ──
function sendOne(toEmail, subject, body) {
  return new Promise((resolve, reject) => {
    if (!SENDGRID_API_KEY) return reject(new Error('SENDGRID_API_KEY not set'));

    const payload = JSON.stringify({
      personalizations: [{ to: [{ email: toEmail }] }],
      from: { email: FROM_EMAIL },
      subject: subject,
      content: [{ type: 'text/plain', value: body }],
    });

    const options = {
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`✅ Email sent to ${toEmail}`);
          resolve({ ok: true, to: toEmail });
        } else {
          const msg = Buffer.concat(chunks).toString();
          console.error(`❌ SendGrid failed for ${toEmail}: ${res.statusCode} ${msg}`);
          reject(new Error(`SendGrid ${res.statusCode}: ${msg}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('SendGrid timeout')); });
    req.write(payload);
    req.end();
  });
}

// ── Send to BOTH Gmail and SMS gateway in parallel ──
async function sendAlert(title, areas) {
  const subject = title;
  const text = `${title}\n${areas.join(', ')}\n${new Date().toLocaleTimeString('he-IL')}`;

  const results = await Promise.allSettled([
    sendOne(GMAIL, subject, text),       // always goes to Gmail inbox
    sendOne(SMS_GATEWAY, subject, text), // also tries Partner SMS gateway
  ]);

  return {
    gmailOk:  results[0].status === 'fulfilled',
    smsOk:    results[1].status === 'fulfilled',
    gmailErr: results[0].reason?.message || null,
    smsErr:   results[1].reason?.message || null,
  };
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
      res.writeHead(500, CORS_HEADERS);
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url === '/send-sms' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const title = body.title || 'Alert';
      const areas = Array.isArray(body.areas) ? body.areas : [];

      const result = await sendAlert(title, areas);
      console.log('Send result:', JSON.stringify(result));

      res.writeHead(200, CORS_HEADERS);
      return res.end(JSON.stringify({
        ok: result.gmailOk || result.smsOk,
        gmailOk:  result.gmailOk,
        smsOk:    result.smsOk,
        gmailErr: result.gmailErr,
        smsErr:   result.smsErr,
      }));
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
  console.log(`   /send-sms → sends to Gmail (${GMAIL}) + SMS gateway (${SMS_GATEWAY})`);
  if (!SENDGRID_API_KEY) console.warn('⚠️  SENDGRID_API_KEY not set — SMS will fail');
});