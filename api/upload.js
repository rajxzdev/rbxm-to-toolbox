module.exports = function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  var chunks = [];
  req.on('data', function(c) { chunks.push(c); });
  req.on('end', function() {
    var buf = Buffer.concat(chunks);
    if (buf.length === 0) return res.status(400).json({ error: 'Empty body' });

    var ct = req.headers['content-type'] || '';
    var bm = ct.match(/boundary=([^\s;]+)/);
    if (!bm) return res.status(400).json({ error: 'No boundary' });

    var parts = parseParts(buf, bm[1]);
    if (!parts.file) return res.status(400).json({ error: 'No file found' });

    var userId = parts.fields.userId || '';
    var apiKey = parts.fields.apiKey || '';
    if (!userId || !apiKey) return res.status(400).json({ error: 'Missing userId or apiKey' });

    var assetType = parts.fields.assetType || 'Model';
    var displayName = (parts.fields.displayName || 'Asset').substring(0, 50);
    var description = (parts.fields.description || 'Uploaded').substring(0, 1000);

    var rType = getType(assetType, parts.file.filename);
    var mime = getMime(parts.file.filename);

    var reqJson = JSON.stringify({
      assetType: rType,
      displayName: displayName,
      description: description,
      creationContext: { creator: { userId: userId } }
    });

    var B = 'RobloxBoundary' + Date.now();
    var nl = '\r\n';

    var p1 = '--' + B + nl + 'Content-Disposition: form-data; name="request"' + nl + 'Content-Type: application/json' + nl + nl + reqJson + nl;
    var p2 = '--' + B + nl + 'Content-Disposition: form-data; name="fileContent"; filename="' + parts.file.filename + '"' + nl + 'Content-Type: ' + mime + nl + nl;
    var p3 = nl + '--' + B + '--' + nl;

    var b1 = Buffer.from(p1);
    var b2 = Buffer.from(p2);
    var b3 = Buffer.from(p3);
    var fd = parts.file.data;

    var total = b1.length + b2.length + fd.length + b3.length;
    var combined = new Uint8Array(total);
    var off = 0;
    combined.set(new Uint8Array(b1.buffer, b1.byteOffset, b1.length), off); off += b1.length;
    combined.set(new Uint8Array(b2.buffer, b2.byteOffset, b2.length), off); off += b2.length;
    combined.set(new Uint8Array(fd.buffer, fd.byteOffset, fd.length), off); off += fd.length;
    combined.set(new Uint8Array(b3.buffer, b3.byteOffset, b3.length), off);

    fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'multipart/form-data; boundary=' + B
      },
      body: combined
    })
    .then(function(rr) {
      return rr.text().then(function(txt) {
        return { status: rr.status, text: txt };
      });
    })
    .then(function(result) {
      var rd;
      try { rd = JSON.parse(result.text); } catch(e) { rd = { raw: result.text }; }

      if (result.status < 200 || result.status >= 300) {
        var msg = rd.message || rd.error || 'Error ' + result.status;
        if (result.status === 401) msg = 'Invalid API Key';
        if (result.status === 403) msg = 'Missing permissions - need Assets Read+Write and IP 0.0.0.0/0';
        if (result.status === 429) msg = 'Rate limited - wait 1 min';
        return res.status(result.status).json({ error: msg, details: rd });
      }

      var aid = null;
      if (rd.assetId) aid = rd.assetId;
      if (rd.response && rd.response.assetId) aid = rd.response.assetId;

      if (!aid && rd.path) {
        return doPoll(rd.path, apiKey, 0).then(function(id) {
          return res.status(200).json({
            success: true,
            assetId: id,
            toolboxUrl: id ? 'https://www.roblox.com/library/' + id : null,
            insertUrl: id ? 'rbxassetid://' + id : null
          });
        });
      }

      return res.status(200).json({
        success: true,
        assetId: aid,
        toolboxUrl: aid ? 'https://www.roblox.com/library/' + aid : null,
        insertUrl: aid ? 'rbxassetid://' + aid : null
      });
    })
    .catch(function(e) {
      return res.status(500).json({ error: 'Fetch failed: ' + e.message });
    });
  });
};

function parseParts(buf, boundary) {
  var result = { fields: {}, file: null };
  var bBuf = Buffer.from('--' + boundary);
  var sep = Buffer.from('\r\n\r\n');
  var positions = [];
  var s = 0;
  while (true) {
    var idx = findBuf(buf, bBuf, s);
    if (idx === -1) break;
    positions.push(idx);
    s = idx + bBuf.length;
  }
  var i;
  for (i = 0; i < positions.length - 1; i++) {
    var start = positions[i] + bBuf.length;
    if (buf[start] === 0x2D && buf[start + 1] === 0x2D) continue;
    if (buf[start] === 0x0D && buf[start + 1] === 0x0A) start = start + 2;
    var end = positions[i + 1];
    if (end >= 2 && buf[end - 2] === 0x0D && buf[end - 1] === 0x0A) end = end - 2;
    var part = buf.slice(start, end);
    var si = findBuf(part, sep, 0);
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

function findBuf(buf, search, from) {
  var i;
  for (i = from; i <= buf.length - search.length; i++) {
    var ok = true;
    var j;
    for (j = 0; j < search.length; j++) {
      if (buf[i + j] !== search[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

function getMime(f) {
  var e = (f || '').split('.').pop().toLowerCase();
  if (e === 'rbxm') return 'model/x.rbxm';
  if (e === 'rbxmx') return 'model/x.rbxmx';
  if (e === 'png') return 'image/png';
  if (e === 'jpg') return 'image/jpeg';
  if (e === 'jpeg') return 'image/jpeg';
  if (e === 'mp3') return 'audio/mpeg';
  if (e === 'ogg') return 'audio/ogg';
  if (e === 'fbx') return 'model/fbx';
  if (e === 'obj') return 'model/obj';
  return 'application/octet-stream';
}

function getType(t, f) {
  var e = (f || '').split('.').pop().toLowerCase();
  if (e === 'rbxm') return 'Model';
  if (e === 'rbxmx') return 'Model';
  if (e === 'png') return 'Decal';
  if (e === 'jpg') return 'Decal';
  if (e === 'jpeg') return 'Decal';
  if (e === 'mp3') return 'Audio';
  if (e === 'ogg') return 'Audio';
  if (e === 'fbx') return 'MeshPart';
  if (e === 'obj') return 'MeshPart';
  var map = { Model: 'Model', Decal: 'Decal', Audio: 'Audio', Mesh: 'MeshPart' };
  return map[t] || 'Model';
}

function doPoll(path, key, n) {
  if (n >= 10) return Promise.resolve(null);
  return new Promise(function(r) { setTimeout(r, 2000); })
  .then(function() {
    return fetch('https://apis.roblox.com/assets/v1/' + path, {
      headers: { 'x-api-key': key }
    });
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    if (d.done) {
      var id = null;
      if (d.response && d.response.assetId) id = d.response.assetId;
      return id;
    }
    return doPoll(path, key, n + 1);
  })
  .catch(function() { return doPoll(path, key, n + 1); });
}

module.exports.config = { api: { bodyParser: false } };
