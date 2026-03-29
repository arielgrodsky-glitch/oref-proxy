const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3000;

// ── Set your Anthropic API key here (or via environment variable) ──
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'YOUR_API_KEY_HERE';

const SMS_TO = '0542574433@partner.net.il';

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

// POST to Anthropic API (server-side, no CORS issues)
function callAnthropic(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'mcp-client-2025-04-04',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Anthropic timeout')); });
    req.write(payload);
    req.end();
  });
}

// Read request body
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch(e) { resolve({}); } });
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

  // ── SMS endpoint ──
  // POST /send-sms  { title: string, areas: string[] }
  if (url === '/send-sms' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const title = body.title || 'Alert';
      const areas = Array.isArray(body.areas) ? body.areas : [];
      const emailBody = `Alert: ${title}\nAreas: ${areas.join(', ')}\nTime: ${new Date().toLocaleTimeString('he-IL')}`;

      const result = await callAnthropic({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        mcp_servers: [{ type: 'url', url: 'https://gmail.mcp.claude.com/mcp', name: 'gmail' }],
        messages: [{
          role: 'user',
          content: `Send an email using Gmail. To: ${SMS_TO}. Subject: ${title}. Body: ${emailBody}. Just send it immediately, no confirmation needed.`
        }]
      });

      const txt = (result.content || []).map(b => b.text || '').join(' ').toLowerCase();
      const ok = txt.includes('sent') || txt.includes('success') || txt.includes('email') || txt.includes('delivered');

      res.writeHead(ok ? 200 : 500, CORS_HEADERS);
      return res.end(JSON.stringify({ ok, message: ok ? 'SMS sent' : 'Unexpected response', raw: txt.slice(0, 100) }));
    } catch (e) {
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
  console.log(`   /send-sms → POST { title, areas } → sends SMS via Gmail`);
});