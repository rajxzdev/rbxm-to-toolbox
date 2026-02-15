var fetch = require('node-fetch');

module.exports = function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (req.headers['x-action'] === 'verify-user') {
    var c0 = [];
    req.on('data', function(c) { c0.push(c); });
    req.on('end', function() {
      try {
        var d = JSON.parse(Buffer.concat(c0).toString());
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

  var chunks = [];
  req.on('data', function(c) { chunks.push(c); });
  req.on('end', function() {
    var buf = Buffer.concat(chunks);
    if (buf.length === 0) return res.status(400).json({ error: 'Empty body' });

    var ct = req.headers['content-type'] || '';
    var bm = ct.match(/boundary=([^\s;]+)/);
    if (!bm) return res.status(400).json({ error: 'No boundary' });

    var parts = parseParts(buf, bm[1]);
    if (!parts.file) return res.status(400).json({ error: 'No file found', fields: Object.keys(parts.fields) });

    var userId = parts.fields.userId || '';
    var apiKey = parts.fields.apiKey || '';
    if (!userId || !apiKey) return res.status(400).json({ error: 'Missing credentials' });

    var assetType = parts.fields.assetType || 'Model';
    var displayName = (parts.fields.displayName || 'Asset').substring(0, 50);
    var description = (parts.fields.description || 'Uploaded').substring(0, 1000);

    var typeMap = { Model: 'Model', Decal: 'Decal', Audio: 'Audio', Mesh: 'MeshPart' };
    var rType = typeMap[assetType] || fileType(parts.file.filename);
    var mime = fileMime(parts.file.filename);

    var reqJson = JSON.stringify({
      assetType: rType,
      displayName: displayName,
      description: description,
      creationContext: { creator: { userId: userId } }
    });

    // Build multipart manually
    var BOUNDARY = '----RobloxBoundary' + Date.now();
    var bodyParts = [];

    // Part 1: JSON request
    bodyParts.push(Buffer.from(
      '--' + BOUNDARY + '\r\n' +
      'Content-Type: application/json\r\n' +
      'Content-Disposition: form-data; name="request"; filename="request.json"\r\n' +
      '\r\n'
    ));
    bodyParts.push(Buffer.from(reqJson));
    bodyParts.push(Buffer.from('\r\n'));

    // Part 2: File content
    bodyParts.push(Buffer.from(
      '--' + BOUNDARY + '\r\n' +
      'Content-Type: ' + mime + '\r\n' +
      'Content-Disposition: form-data; name="fileContent"; filename="' + parts.file.filename + '"\r\n' +
      '\r\n'
    ));
    bodyParts.push(parts.file.data);
    bodyParts.push(Buffer.from('\r\n'));

    // End boundary
    bodyParts.push(Buffer.from('--' + BOUNDARY + '--\r\n'));

    var fullBody = Buffer.concat(bodyParts);

    fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'multipart/form-data; boundary=' + BOUNDARY,
        'Content-Length': fullBody.length
      },
      body: fullBody
    })
    .then(function(ur) {
      return ur.text().then(function(rt) {
        var rd;
        try { rd = JSON.parse(rt); } catch(e) { rd = { raw: rt }; }

        if (!ur.ok) {
          var msg = rd.message || rd.error || 'Error ' + ur.status;
          if (ur.status === 401) msg = 'Invalid API Key';
          if (ur.status === 403) msg = 'Missing permissions - need Assets Read+Write and IP 0.0.0.0/0';
          if (ur.status === 429) msg = 'Rate limited';
          return res.status(ur.status).json({ error: msg, details: rd });
        }

        var aid = rd.assetId || (rd.response && rd.response.assetId) || null;

        if (!aid && rd.path) {
          return doPoll(rd.path, apiKey, 0).then(function(id) {
            res.status(200).json({
              success: true, assetId: id,
              toolboxUrl: id ? 'https://www.roblox.com/library/' + id : null,
              insertUrl: id ? 'rbxassetid://' + id : null
            });
          });
        }

        res.status(200).json({
          success: true, assetId: aid,
          toolboxUrl: aid ? 'https://www.roblox.com/library/' + aid : null,
          insertUrl: aid ? 'rbxassetid://' + aid : null
        });
      });
    })
    .catch(function(e) {
      res.status(500).json({ error: 'Fetch failed: ' + e.message });
    });
  });
};

function parseParts(buf, boundary) {
  var result = { fields: {}, file: null };
  var bBuf = Buffer.from('--' + boundary);

  var positions = [];
  var s = 0;
  while (true) {
    var idx = findIn(buf, bBuf, s);
    if (idx === -1) break;
    positions.push(idx);
    s = idx + bBuf.length;
  }

  var sep = Buffer.from('\r\n\r\n');

  for (var i = 0; i < positions.length - 1; i++) {
    var start = positions[i] + bBuf.length;
    if (buf[start] === 0x2D && buf[start+1] === 0x2D) continue;
    if (buf[start] === 0x0D && buf[start+1] === 0x0A) start += 2;

    var end = positions[i+1];
    if (buf[end-2] === 0x0D && buf[end-1] === 0x0A) end -= 2;

    var part = buf.slice(start, end);
    var si = findIn(part, sep, 0);
    if (si === -1) continue;

    var head = part.slice(0, si).toString('utf8');
    var body = part.slice(si + 4);

    var nm = head.match(/name="([^"]+)"/);
    if (!nm) continue;

    var fn = head.match(/filename="([^"]+)"/);
    if (fn) {
      result.file = { filename: fn[1], data: body };
    } else {
      result.fields[nm[1]] = body.toString('utf8');
    }
  }
  return result;
}

function findIn(buf, search, from) {
  for (var i = from; i <= buf.length - search.length; i++) {
    var ok = true;
    for (var j = 0; j < search.length; j++) {
      if (buf[i+j] !== search[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

function fileMime(f) {
  var e = (f || '').split('.').pop().toLowerCase();
  return { rbxm:'application/xml', rbxmx:'application/xml', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', mp3:'audio/mpeg', ogg:'audio/ogg', fbx:'model/fbx', obj:'model/obj' }[e] || 'application/octet-stream';
}

function fileType(f) {
  var e = (f || '').split('.').pop().toLowerCase();
  return { rbxm:'Model', rbxmx:'Model', png:'Decal', jpg:'Decal', jpeg:'Decal', mp3:'Audio', ogg:'Audio', fbx:'MeshPart', obj:'MeshPart' }[e] || 'Model';
}

function doPoll(path, key, n) {
  if (n >= 10) return Promise.resolve(null);
  return new Promise(function(r) { setTimeout(r, 2000); })
  .then(function() {
    return fetch('https://apis.roblox.com/assets/v1/' + path, { headers: { 'x-api-key': key } });
  })
  .then(function(r) {
    if (!r.ok) return doPoll(path, key, n+1);
    return r.json().then(function(d) {
      if (d.done) return d.response && d.response.assetId;
      return doPoll(path, key, n+1);
    });
  })
  .catch(function() { return doPoll(path, key, n+1); });
}

module.exports.config = { api: { bodyParser: false } };
