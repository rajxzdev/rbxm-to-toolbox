var fetch = require('node-fetch');
var FormData = require('form-data');

module.exports = function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Skip if verify
  if (req.headers['x-action'] === 'verify-user') {
    var chunks0 = [];
    req.on('data', function(c) { chunks0.push(c); });
    req.on('end', function() {
      try {
        var d = JSON.parse(Buffer.concat(chunks0).toString());
        fetch('https://users.roblox.com/v1/users/' + d.userId)
        .then(function(r) { return r.json(); })
        .then(function(u) {
          res.status(200).json({ valid: true, displayName: u.displayName || u.name });
        })
        .catch(function(e) { res.status(400).json({ error: e.message }); });
      } catch(e) { res.status(400).json({ error: e.message }); }
    });
    return;
  }

  // Collect raw body
  var chunks = [];
  req.on('data', function(c) { chunks.push(c); });
  req.on('end', function() {
    var buf = Buffer.concat(chunks);

    if (buf.length === 0) {
      return res.status(400).json({ error: 'Empty body', size: 0 });
    }

    var ct = req.headers['content-type'] || '';
    var bm = ct.match(/boundary=([^\s;]+)/);
    if (!bm) {
      return res.status(400).json({ error: 'No boundary', ct: ct });
    }

    var boundary = bm[1];
    var parts = parseMultipartBuffer(buf, boundary);

    if (!parts.file) {
      return res.status(400).json({
        error: 'File not parsed',
        partsFound: Object.keys(parts.fields),
        hasFile: false,
        bodySize: buf.length,
        boundary: boundary
      });
    }

    var userId = parts.fields.userId || '';
    var apiKey = parts.fields.apiKey || '';
    var assetType = parts.fields.assetType || 'Model';
    var displayName = (parts.fields.displayName || 'Asset').substring(0, 50);
    var description = (parts.fields.description || 'Uploaded').substring(0, 1000);

    if (!userId || !apiKey) {
      return res.status(400).json({ error: 'Missing userId or apiKey' });
    }

    // Map types
    var typeMap = { Model: 'Model', Decal: 'Decal', Audio: 'Audio', Mesh: 'MeshPart' };
    var rType = typeMap[assetType] || getTypeFromFile(parts.file.filename);
    var mime = getMime(parts.file.filename);

    var reqBody = {
      assetType: rType,
      displayName: displayName,
      description: description,
      creationContext: { creator: { userId: userId } }
    };

    // Build form-data for Roblox
    var fd = new FormData();
    fd.append('request', JSON.stringify(reqBody), {
      contentType: 'application/json',
      filename: 'request.json'
    });
    fd.append('fileContent', parts.file.data, {
      filename: parts.file.filename,
      contentType: mime
    });

    var headers = { 'x-api-key': apiKey };
    var fdh = fd.getHeaders();
    for (var k in fdh) headers[k] = fdh[k];

    fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST',
      headers: headers,
      body: fd
    })
    .then(function(ur) {
      return ur.text().then(function(rt) {
        var rd;
        try { rd = JSON.parse(rt); } catch(e) { rd = { raw: rt }; }

        if (!ur.ok) {
          var msg = rd.message || rd.error || 'Roblox error ' + ur.status;
          if (ur.status === 401) msg = 'Invalid API Key';
          if (ur.status === 403) msg = 'Missing permissions - need Assets Read+Write and IP 0.0.0.0/0';
          if (ur.status === 429) msg = 'Rate limited - wait 1 min';
          return res.status(ur.status).json({ error: msg, details: rd });
        }

        var aid = rd.assetId || (rd.response && rd.response.assetId) || null;

        if (!aid && rd.path) {
          return pollOp(rd.path, apiKey, 0).then(function(id) {
            res.status(200).json({
              success: true,
              assetId: id,
              toolboxUrl: id ? 'https://www.roblox.com/library/' + id : null,
              insertUrl: id ? 'rbxassetid://' + id : null
            });
          });
        }

        res.status(200).json({
          success: true,
          assetId: aid,
          toolboxUrl: aid ? 'https://www.roblox.com/library/' + aid : null,
          insertUrl: aid ? 'rbxassetid://' + aid : null
        });
      });
    })
    .catch(function(e) {
      res.status(500).json({ error: 'Upload failed: ' + e.message });
    });
  });
};

function parseMultipartBuffer(buf, boundary) {
  var result = { fields: {}, file: null };
  var bStr = '--' + boundary;
  var bBuf = Buffer.from(bStr);
  var crlf = Buffer.from('\r\n');
  var crlfcrlf = Buffer.from('\r\n\r\n');

  // Find all boundary positions
  var positions = [];
  var searchFrom = 0;
  while (true) {
    var idx = bufferIndexOf(buf, bBuf, searchFrom);
    if (idx === -1) break;
    positions.push(idx);
    searchFrom = idx + bBuf.length;
  }

  for (var i = 0; i < positions.length - 1; i++) {
    // Content starts after boundary + CRLF
    var contentStart = positions[i] + bBuf.length;

    // Skip CRLF or -- after boundary
    if (buf[contentStart] === 0x2D && buf[contentStart + 1] === 0x2D) continue; // end boundary
    if (buf[contentStart] === 0x0D && buf[contentStart + 1] === 0x0A) contentStart += 2;

    var contentEnd = positions[i + 1];
    // Remove trailing CRLF before next boundary
    if (buf[contentEnd - 2] === 0x0D && buf[contentEnd - 1] === 0x0A) contentEnd -= 2;

    var partBuf = buf.slice(contentStart, contentEnd);

    // Find header/body separator
    var sepIdx = bufferIndexOf(partBuf, crlfcrlf, 0);
    if (sepIdx === -1) continue;

    var headerBuf = partBuf.slice(0, sepIdx);
    var bodyBuf = partBuf.slice(sepIdx + 4);

    var headerStr = headerBuf.toString('utf8');

    var nameMatch = headerStr.match(/name="([^"]+)"/);
    if (!nameMatch) continue;

    var filenameMatch = headerStr.match(/filename="([^"]+)"/);

    if (filenameMatch) {
      result.file = {
        name: nameMatch[1],
        filename: filenameMatch[1],
        data: bodyBuf
      };
    } else {
      result.fields[nameMatch[1]] = bodyBuf.toString('utf8');
    }
  }

  return result;
}

function bufferIndexOf(buf, search, from) {
  for (var i = from; i <= buf.length - search.length; i++) {
    var found = true;
    for (var j = 0; j < search.length; j++) {
      if (buf[i + j] !== search[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}

function getMime(f) {
  var e = (f || '').split('.').pop().toLowerCase();
  return {
    rbxm: 'application/xml', rbxmx: 'application/xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    mp3: 'audio/mpeg', ogg: 'audio/ogg',
    fbx: 'model/fbx', obj: 'model/obj'
  }[e] || 'application/octet-stream';
}

function getTypeFromFile(f) {
  var e = (f || '').split('.').pop().toLowerCase();
  return {
    rbxm: 'Model', rbxmx: 'Model',
    png: 'Decal', jpg: 'Decal', jpeg: 'Decal',
    mp3: 'Audio', ogg: 'Audio',
    fbx: 'MeshPart', obj: 'MeshPart'
  }[e] || 'Model';
}

function pollOp(path, key, n) {
  if (n >= 10) return Promise.resolve(null);
  return new Promise(function(r) { setTimeout(r, 2000); })
  .then(function() {
    return fetch('https://apis.roblox.com/assets/v1/' + path, {
      headers: { 'x-api-key': key }
    });
  })
  .then(function(r) {
    if (!r.ok) return pollOp(path, key, n + 1);
    return r.json().then(function(d) {
      if (d.done) return d.response && d.response.assetId;
      return pollOp(path, key, n + 1);
    });
  })
  .catch(function() { return pollOp(path, key, n + 1); });
}

module.exports.config = {
  api: { bodyParser: false }
};
