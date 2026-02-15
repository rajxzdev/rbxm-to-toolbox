const multiparty = require('multiparty');
const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');

function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = new multiparty.Form({ maxFilesSize: 50 * 1024 * 1024 });
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

async function verifyUser(userId, apiKey) {
  try {
    const res = await fetch(`https://apis.roblox.com/cloud/v2/users/${userId}`, {
      headers: { 'x-api-key': apiKey }
    });
    if (res.ok) {
      const data = await res.json();
      return { valid: true, displayName: data.displayName || data.name || userId };
    }
    const res2 = await fetch(`https://users.roblox.com/v1/users/${userId}`);
    if (res2.ok) {
      const data2 = await res2.json();
      return { valid: true, displayName: data2.displayName || data2.name || userId };
    }
    return { valid: false, error: 'User ID not found' };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

async function verifyApiKey(userId, apiKey) {
  try {
    const res = await fetch(
      `https://apis.roblox.com/assets/v1/assets`,
      {
        method: 'HEAD',
        headers: { 'x-api-key': apiKey }
      }
    );
    if (res.status === 401 || res.status === 403) {
      return { valid: false, error: 'Invalid API Key or insufficient permissions' };
    }
    return { valid: true };
  } catch (e) {
    return { valid: true };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const url = req.url.split('?')[0];

  // Verify user endpoint
  if (url === '/api/upload' && req.headers['x-action'] === 'verify-user') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { userId, apiKey } = JSON.parse(body);

    const userCheck = await verifyUser(userId, apiKey);
    if (!userCheck.valid) return res.status(400).json({ error: userCheck.error });

    const keyCheck = await verifyApiKey(userId, apiKey);

    return res.status(200).json({
      valid: true,
      displayName: userCheck.displayName,
      keyValid: keyCheck.valid,
      keyError: keyCheck.error || null
    });
  }

  // Upload endpoint
  try {
    const { fields, files } = await parseForm(req);

    const userId = fields.userId?.[0];
    const apiKey = fields.apiKey?.[0];
    const assetType = fields.assetType?.[0] || 'Model';
    const displayName = fields.displayName?.[0] || 'Uploaded Asset';
    const description = fields.description?.[0] || 'Uploaded via RBXM Converter';
    const file = files.file?.[0];

    if (!userId || !apiKey || !file) {
      return res.status(400).json({ error: 'Missing userId, apiKey, or file' });
    }

    const fileBuffer = fs.readFileSync(file.path);

    const assetTypeMap = {
      'Model': 'Model',
      'Decal': 'Decal',
      'Audio': 'Audio',
      'Mesh': 'MeshPart',
      'Animation': 'Animation'
    };

    const requestBody = {
      assetType: assetTypeMap[assetType] || 'Model',
      displayName: displayName.substring(0, 50),
      description: description.substring(0, 1000),
      creationContext: {
        creator: {
          userId: userId
        }
      }
    };

    const formData = new FormData();
    formData.append('request', JSON.stringify(requestBody), {
      contentType: 'application/json'
    });
    formData.append('fileContent', fileBuffer, {
      filename: file.originalFilename || 'asset.rbxm',
      contentType: 'application/octet-stream'
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
    let responseData;
    try { responseData = JSON.parse(responseText); } catch { responseData = { raw: responseText }; }

    if (!uploadRes.ok) {
      return res.status(uploadRes.status).json({
        error: responseData.message || responseData.error || `Roblox API error ${uploadRes.status}`,
        details: responseData
      });
    }

    // Poll operation if needed
    if (responseData.path && responseData.done === false) {
      let operationPath = responseData.path;
      let attempts = 0;
      while (attempts < 10) {
        await new Promise(r => setTimeout(r, 2000));
        const pollRes = await fetch(`https://apis.roblox.com/assets/v1/${operationPath}`, {
          headers: { 'x-api-key': apiKey }
        });
        if (pollRes.ok) {
          const pollData = await pollRes.json();
          if (pollData.done) {
            responseData = pollData;
            break;
          }
        }
        attempts++;
      }
    }

    let assetId = null;
    if (responseData.response?.assetId) {
      assetId = responseData.response.assetId;
    } else if (responseData.assetId) {
      assetId = responseData.assetId;
    } else if (responseData.response?.path) {
      const match = responseData.response.path.match(/assets\/(\d+)/);
      if (match) assetId = match[1];
    } else if (responseData.path) {
      const match = responseData.path.match(/assets\/(\d+)/);
      if (match) assetId = match[1];
    }

    // Cleanup
    try { fs.unlinkSync(file.path); } catch {}

    return res.status(200).json({
      success: true,
      assetId: assetId,
      toolboxUrl: assetId ? `https://www.roblox.com/library/${assetId}` : null,
      insertUrl: assetId ? `rbxassetid://${assetId}` : null,
      raw: responseData
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
