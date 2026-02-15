const Busboy = require('busboy');
const fetch = require('node-fetch');
const FormData = require('form-data');

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = {};

    const busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: 50 * 1024 * 1024 }
    });

    busboy.on('field', (name, val) => {
      fields[name] = val;
    });

    busboy.on('file', (name, stream, info) => {
      const { filename, mimeType } = info;
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        files[name] = {
          buffer: Buffer.concat(chunks),
          filename: filename,
          mimeType: mimeType
        };
      });
    });

    busboy.on('finish', () => resolve({ fields, files }));
    busboy.on('error', reject);

    req.pipe(busboy);
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
    return { valid: false, error: 'User ID not found on Roblox' };
  } catch (e) {
    return { valid: false, error: 'Cannot reach Roblox API: ' + e.message };
  }
}

async function testApiKey(apiKey) {
  try {
    const res = await fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'GET',
      headers: { 'x-api-key': apiKey }
    });
    if (res.status === 401) return { valid: false, error: 'API Key is invalid (401)' };
    if (res.status === 403) return { valid: false, error: 'API Key lacks Assets permissions (403)' };
    return { valid: true };
  } catch (e) {
    return { valid: true, warning: 'Could not fully verify key' };
  }
}

// Correct MIME types for Roblox API
function getRobloxMimeType(assetType, filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();

  const mimeMap = {
    'Model': {
      'rbxm': 'application/xml',
      'rbxmx': 'application/xml'
    },
    'Decal': {
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'bmp': 'image/bmp',
      'tga': 'image/tga'
    },
    'Audio': {
      'mp3': 'audio/mpeg',
      'ogg': 'audio/ogg'
    },
    'MeshPart': {
      'fbx': 'model/fbx',
      'obj': 'model/obj'
    }
  };

  if (mimeMap[assetType] && mimeMap[assetType][ext]) {
    return mimeMap[assetType][ext];
  }

  // Fallback by extension
  const fallback = {
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

  return fallback[ext] || 'application/octet-stream';
}

// Correct Roblox asset type names
function getRobloxAssetType(type, filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();

  // Auto-detect from file extension
  if (ext === 'rbxm' || ext === 'rbxmx') return 'Model';
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg') return 'Decal';
  if (ext === 'mp3' || ext === 'ogg') return 'Audio';
  if (ext === 'fbx' || ext === 'obj') return 'MeshPart';

  const typeMap = {
    'Model': 'Model',
    'Decal': 'Decal',
    'Audio': 'Audio',
    'Mesh': 'MeshPart'
  };

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
      let body = '';
      for await (const chunk of req) body += chunk;
      const { userId, apiKey } = JSON.parse(body);

      if (!userId || !apiKey) return res.status(400).json({ error: 'Missing userId or apiKey' });
      if (!/^\d+$/.test(userId)) return res.status(400).json({ error: 'User ID must be a number' });

      const userCheck = await verifyUser(userId);
      if (!userCheck.valid) return res.status(400).json({ error: userCheck.error });

      const keyCheck = await testApiKey(apiKey);

      return res.status(200).json({
        valid: true,
        displayName: userCheck.displayName,
        keyValid: keyCheck.valid,
        keyError: keyCheck.error || null,
        keyWarning: keyCheck.warning || null
      });
    } catch (e) {
      return res.status(400).json({ error: 'Invalid request: ' + e.message });
    }
  }

  // ====== UPLOAD ASSET ======
  try {
    const { fields, files } = await parseMultipart(req);

    const userId = fields.userId;
    const apiKey = fields.apiKey;
    const assetType = fields.assetType || 'Model';
    const displayName = (fields.displayName || 'Uploaded Asset').substring(0, 50);
    const description = (fields.description || 'Uploaded via RBXM Converter').substring(0, 1000);
    const file = files.file;

    if (!userId || !apiKey) return res.status(400).json({ error: 'Missing userId or apiKey' });
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    // Get correct types for Roblox
    const robloxType = getRobloxAssetType(assetType, file.filename);
    const mimeType = getRobloxMimeType(robloxType, file.filename);

    console.log('Upload details:', {
      userId,
      assetType: robloxType,
      mimeType: mimeType,
      displayName,
      fileSize: file.buffer.length,
      fileName: file.filename
    });

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

    // Build multipart form for Roblox API
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
    console.log('Roblox status:', uploadRes.status);
    console.log('Roblox response:', responseText);

    let responseData;
    try { responseData = JSON.parse(responseText); } catch { responseData = { rawText: responseText }; }

    if (!uploadRes.ok) {
      let errorMsg = 'Roblox API error ' + uploadRes.status;

      if (uploadRes.status === 401) errorMsg = 'Invalid API Key';
      else if (uploadRes.status === 403) errorMsg = 'API Key lacks permissions — enable Assets Read+Write and IP 0.0.0.0/0';
      else if (uploadRes.status === 400) errorMsg = responseData.message || 'Bad request — check file format';
      else if (uploadRes.status === 429) errorMsg = 'Rate limited — wait a minute';

      if (responseData.message) errorMsg = responseData.message;

      return res.status(uploadRes.status).json({
        error: errorMsg,
        details: responseData
      });
    }

    // Handle async operation
    let assetId = null;
    let finalData = responseData;

    if (responseData.assetId) assetId = responseData.assetId;
    else if (responseData.response?.assetId) assetId = responseData.response.assetId;

    // Poll operation
    if (!assetId && responseData.path) {
      let attempts = 0;
      while (attempts < 15) {
        await new Promise(r => setTimeout(r, 2000));
        attempts++;
        try {
          const pollRes = await fetch(
            `https://apis.roblox.com/assets/v1/${responseData.path}`,
            { headers: { 'x-api-key': apiKey } }
          );
          if (pollRes.ok) {
            const pollData = await pollRes.json();
            console.log(`Poll ${attempts}:`, JSON.stringify(pollData));
            if (pollData.done === true) {
              finalData = pollData;
              if (pollData.response?.assetId) assetId = pollData.response.assetId;
              break;
            }
          }
        } catch (e) {
          console.log('Poll error:', e.message);
        }
      }

      if (!assetId) {
        if (finalData.response?.path) {
          const m = finalData.response.path.match(/assets\/(\d+)/);
          if (m) assetId = m[1];
        }
        if (!assetId && finalData.path) {
          const m = finalData.path.match(/assets\/(\d+)/);
          if (m) assetId = m[1];
        }
      }
    }

    return res.status(200).json({
      success: true,
      assetId: assetId,
      toolboxUrl: assetId ? `https://www.roblox.com/library/${assetId}` : null,
      insertUrl: assetId ? `rbxassetid://${assetId}` : null,
      raw: finalData
    });

  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

module.exports.config = {
  api: {
    bodyParser: false
  }
};
