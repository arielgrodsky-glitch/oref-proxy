const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3000;

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
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

        // Handle UTF-16-LE BOM (common in Oref responses)
        if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
          encoding = 'utf16le';
          data = buffer.slice(2);
        }
        // Handle UTF-8 BOM
        else if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
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

const server = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  const url = req.url.split('?')[0];

  // Health check
  if (url === '/' || url === '/health') {
    res.writeHead(200, CORS_HEADERS);
    return res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
  }

  // Live alerts endpoint
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

  // Alert history endpoint (last ~2 hours)
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

  res.writeHead(404, CORS_HEADERS);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`✅ Oref proxy running on http://localhost:${PORT}`);
  console.log(`   /alerts  → live active alerts`);
  console.log(`   /history → last ~2 hours of alerts`);
});
