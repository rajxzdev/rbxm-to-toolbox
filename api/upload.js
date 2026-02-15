const fetch = require('node-fetch');
const FormData = require('form-data');

function getBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(body, boundary) {
  const parts = [];
  const b = '--' + boundary;
  const str = body.toString('latin1');
  const sections = str.split(b).slice(1, -1);

  for (const section of sections) {
    const headerEnd = section.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const header = section.slice(0, headerEnd);
    const content = section.slice(headerEnd + 4).replace(/\r\n$/, '');

    const nameMatch = header.match(/name="([^"]+)"/);
    const fileMatch = header.match(/filename="([^"]+)"/);

    if (!nameMatch) continue;

    if (fileMatch) {
      const start = body.indexOf(Buffer.from(content.slice(0, 50), 'latin1'), 
        body.indexOf(Buffer.from(header.slice(0, 50), 'latin1')));
      parts.push({
        name: nameMatch[1],
        filename: fileMatch[1],
        data: body.slice(start, start + content.length)
      });
    } else {
      parts.push({
        name: nameMatch[1],
        filename: null,
        data: content
      });
    }
  }
  return parts;
}

function getMime(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  return {
    rbxm: 'application/xml',
    rbxmx: 'application/xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    fbx: 'model/fbx',
    obj: 'model/obj'
  }[ext] || 'application/octet-stream';
}

function getAssetType(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  return {
    rbxm: 'Model',
    rbxmx: 'Model',
    png: 'Decal',
    jpg: 'Decal',
    jpeg: 'Decal',
    mp3: 'Audio',
    ogg: 'Audio',
    fbx: 'MeshPart',
    obj: 'MeshPart'
  }[ext] || 'Model';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-action');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // ====== VERIFY ======
  if (req.headers['x-action'] === 'verify-user') {
    try {
      const raw = await getBody(req);
      const { userId, apiKey } = JSON.parse(raw.toString());

      if (!userId || !apiKey) return res.status(400).json({ error: 'Missing fields' });
      if (!/^\d+$/.test(userId)) return res.status(400).json({ error: 'User ID must be number' });

      const ur = await fetch('https://users.roblox.com/v1/users/' + userId);
      if (!ur.ok) return res.status(400).json({ error: 'User ID not found' });
      const ud = await ur.json();
      if (ud.isBanned) return res.status(400).json({ error: 'User is banned' });

      let keyValid = true, keyError = null;
      try {
        const kr = await fetch('https://apis.roblox.com/assets/v1/assets', {
          headers: { 'x-api-key': apiKey }
        });
        if (kr.status === 401) { keyValid = false; keyError = 'Invalid API Key'; }
        if (kr.status === 403) { keyValid = false; keyError = 'Missing permissions'; }
      } catch (e) {}

      return res.status(200).json({
        valid: true,
        displayName: ud.displayName || ud.name,
        keyValid: keyValid,
        keyError: keyError
      });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  // ====== UPLOAD ======
  try {
    const ct = req.headers['content-type'] || '';
    const bm = ct.match(/boundary=(.+)/);
    if (!bm) return res.status(400).json({ error: 'Invalid request' });

    const body = await getBody(req);
    const parts = parseMultipart(body, bm[1].trim());

    const fields = {};
    let file = null;

    for (const p of parts) {
      if (p.filename) {
        file = { buffer: p.data, filename: p.filename };
      } else {
        fields[p.name] = typeof p.data === 'string' ? p.data : p.data.toString();
      }
    }

    if (!fields.userId || !fields.apiKey) return res.status(400).json({ error: 'Missing credentials' });
    if (!file) return res.status(400).json({ error: 'No file' });

    const rType = getAssetType(file.filename);
    const mime = getMime(file.filename);
    const name = (fields.displayName || 'Asset').substring(0, 50);
    const desc = (fields.description || 'Uploaded via converter').substring(0, 1000);

    const reqBody = {
      assetType: rType,
      displayName: name,
      description: desc,
      creationContext: { creator: { userId: fields.userId } }
    };

    const fd = new FormData();
    fd.append('request', JSON.stringify(reqBody), {
      contentType: 'application/json',
      filename: 'request.json'
    });
    fd.append('fileContent', file.buffer, {
      filename: file.filename,
      contentType: mime
    });

    const ur = await fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST',
      headers: { 'x-api-key': fields.apiKey, ...fd.getHeaders() },
      body: fd
    });

    const rt = await ur.text();
    let rd;
    try { rd = JSON.parse(rt); } catch { rd = { raw: rt }; }

    if (!ur.ok) {
      let msg = rd.message || rd.error || 'Error ' + ur.status;
      if (ur.status === 401) msg = 'Invalid API Key';
      if (ur.status === 403) msg = 'Missing permissions - add Assets Read+Write and IP 0.0.0.0/0';
      if (ur.status === 429) msg = 'Rate limited - wait 1 min';
      return res.status(ur.status).json({ error: msg });
    }

    let assetId = rd.assetId || (rd.response && rd.response.assetId) || null;

    if (!assetId && rd.path) {
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const pr = await fetch('https://apis.roblox.com/assets/v1/' + rd.path, {
            headers: { 'x-api-key': fields.apiKey }
          });
          if (pr.ok) {
            const pd = await pr.json();
            if (pd.done) {
              assetId = pd.response && pd.response.assetId;
              rd = pd;
              break;
            }
          }
        } catch (e) {}
      }
    }

    if (!assetId) {
      var paths = [rd.response && rd.response.path, rd.path].filter(Boolean);
      for (var p of paths) {
        var m = p.match(/assets\/(\d+)/);
        if (m) { assetId = m[1]; break; }
      }
    }

    return res.status(200).json({
      success: true,
      assetId: assetId,
      toolboxUrl: assetId ? 'https://www.roblox.com/library/' + assetId : null,
      insertUrl: assetId ? 'rbxassetid://' + assetId : null
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

module.exports.config = {
  api: { bodyParser: false }
};
