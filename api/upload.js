const fetch = require('node-fetch');
const FormData = require('form-data');

// Parse multipart tanpa library external
function parseMultipart(body, boundary) {
  const parts = [];
  const boundaryBuffer = Buffer.from('--' + boundary);
  const endBuffer = Buffer.from('--' + boundary + '--');

  let start = body.indexOf(boundaryBuffer) + boundaryBuffer.length + 2;

  while (start < body.length) {
    const end = body.indexOf(boundaryBuffer, start);
    if (end === -1) break;

    const part = body.slice(start, end - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) { start = end + boundaryBuffer.length + 2; continue; }

    const headerStr = part.slice(0, headerEnd).toString();
    const content = part.slice(headerEnd + 4);

    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const fileMatch = headerStr.match(/filename="([^"]+)"/);
    const typeMatch = headerStr.match(/Content-Type:\s*(.+)/i);

    if (nameMatch) {
      parts.push({
        name: nameMatch[1],
        filename: fileMatch ? fileMatch[1] : null,
        contentType: typeMatch ? typeMatch[1].trim() : null,
        data: content
      });
    }

    start = end + boundaryBuffer.length + 2;
  }

  return parts;
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function verifyUser(userId) {
  try {
    const res = await fetch(`https://users.roblox.com/v1/users/${userId}`);
    if (res.ok) {
      const data = await res.json();
      if (data.isBanned) return { valid: false, error: 'User is banned' };
      return { valid: true, displayName: data.displayName || data.name };
    }
    return { valid: false, error: 'User ID not found' };
  } catch (e) {
    return { valid: false, error: 'Cannot reach Roblox: ' + e.message };
  }
}

function getRobloxMimeType(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const map = {
    'rbxm': 'application/xml',
    'rbxmx': 'application/xml',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'mp3': 'audio/mpeg',
    'ogg': 'audio/ogg',
    'fbx': 'model/fbx',
    'obj': 'model/obj'
  };
  return map[ext] || 'application/octet-stream';
}

function getRobloxAssetType(type, filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  if (ext === 'rbxm' || ext === 'rbxmx') return 'Model';
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg') return 'Decal';
  if (ext === 'mp3' || ext === 'ogg') return 'Audio';
  if (ext === 'fbx' || ext === 'obj') return 'MeshPart';
  const typeMap = { 'Model': 'Model', 'Decal': 'Decal', 'Audio': 'Audio', 'Mesh': 'MeshPart' };
  return typeMap[type] || 'Model';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-action');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const action = req.headers['x-action'];

  // ====== VERIFY USER ======
  if (action === 'verify-user') {
    try {
      const raw = await getBody(req);
      const { userId, apiKey } = JSON.parse(raw.toString());

      if (!userId || !apiKey) return res.status(400).json({ error: 'Missing userId or apiKey' });
      if (!/^\d+$/.test(userId)) return res.status(400).json({ error: 'User ID must be a number' });

      const userCheck = await verifyUser(userId);
      if (!userCheck.valid) return res.status(400).json({ error: userCheck.error });

      // Test API key
      let keyValid = true, keyError = null;
      try {
        const kr = await fetch('https://apis.roblox.com/assets/v1/assets', {
          headers: { 'x-api-key': apiKey }
        });
        if (kr.status === 401) { keyValid = false; keyError = 'API Key invalid (401)'; }
        if (kr.status === 403) { keyValid = false; keyError = 'API Key lacks permissions (403)'; }
      } catch (e) { /* ignore */ }

      return res.status(200).json({
        valid: true,
        displayName: userCheck.displayName,
        keyValid,
        keyError
      });
    } catch (e) {
      return res.status(400).json({ error: 'Invalid request: ' + e.message });
    }
  }

  // ====== UPLOAD ASSET ======
  try {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);

    if (!boundaryMatch) {
      return res.status(400).json({ error: 'Invalid request format' });
    }

    const body = await getBody(req);
    const boundary = boundaryMatch[1].trim();
    const parts = parseMultipart(body, boundary);

    // Extract fields
    const fields = {};
    let file = null;

    for (const part of parts) {
      if (part.filename) {
        file = {
          buffer: part.data,
          filename: part.filename,
          mimeType: part.contentType
        };
      } else {
        fields[part.name] = part.data.toString();
      }
    }

    const userId = fields.userId;
    const apiKey = fields.apiKey;
    const assetType = fields.assetType || 'Model';
    const displayName = (fields.displayName || 'Uploaded Asset').substring(0, 50);
    const description = (fields.description || 'Uploaded via RBXM Converter').substring(0, 1000);

    if (!userId || !apiKey) return res.status(400).json({ error: 'Missing userId or apiKey' });
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    const robloxType = getRobloxAssetType(assetType, file.filename);
    const mimeType = getRobloxMimeType(file.filename);

    console.log('Upload:', { userId, robloxType, mimeType, displayName, fileSize: file.buffer.length, fileName: file.filename });

    const requestBody = {
      assetType: robloxType,
      displayName: displayName,
      description: description,
      creationContext: {
        creator: {
          userId: userId
        }
      }
    };

    const formData = new FormData();
    formData.append('request', JSON.stringify(requestBody), {
      contentType: 'application/json',
      filename: 'request.json'
    });
    formData.append('fileContent', file.buffer, {
      filename: file.filename || 'asset.rbxm',
      contentType: mimeType
    });

    const uploadRes = await fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        ...formData.getHeaders()
      },
      body: formData
    });

    const responseText = await uploadRes.text();
    console.log('Roblox:', uploadRes.status, responseText);

    let responseData;
    try { responseData = JSON.parse(responseText); } catch { responseData = { rawText: responseText }; }

    if (!uploadRes.ok) {
      let errorMsg = responseData.message || responseData.error || 'Roblox API error ' + uploadRes.status;
      if (uploadRes.status === 401) errorMsg = 'Invalid API Key';
      else if (uploadRes.status === 403) errorMsg = 'API Key lacks permissions';
      else if (uploadRes.status === 429) errorMsg = 'Rate limited — wait a minute';
      return res.status(uploadRes.status).json({ error: errorMsg, details: responseData });
    }

    // Get asset ID
    let assetId = responseData.assetId || responseData.response?.assetId || null;

    // Poll operation
    if (!assetId && responseData.path) {
      let attempts = 0;
      while (attempts < 15) {
        await new Promise(r => setTimeout(r, 2000));
        attempts++;
        try {
          const pr = await fetch(`https://apis.roblox.com/assets/v1/${responseData.path}`, {
            headers: { 'x-api-key': apiKey }
          });
          if (pr.ok) {
            const pd = await pr.json();
            if (pd.done) {
              assetId = pd.response?.assetId;
              responseData = pd;
              break;
            }
          }
        } catch (e) { console.log('Poll err:', e.message); }
      }

      if (!assetId) {
        const paths = [responseData.response?.path, responseData.path].filter(Boolean);
        for (const p of paths) {
          const m = p.match(/assets\/(\d+)/);
          if (m) { assetId = m[1]; break; }
        }
      }
    }

    return res.status(200).json({
      success: true,
      assetId,
      toolboxUrl: assetId ? `https://www.roblox.com/library/${assetId}` : null,
      insertUrl: assetId ? `rbxassetid://${assetId}` : null,
      raw: responseData
    });

  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

module.exports.config = {
  api: {
    bodyParser: false
  }
};
