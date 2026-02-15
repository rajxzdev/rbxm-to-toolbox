var fetch = require('node-fetch');
var FormData = require('form-data');

function getRawBody(req) {
  if (req.body) {
    if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
    if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body));
    return Promise.resolve(Buffer.from(JSON.stringify(req.body)));
  }
  return new Promise(function(ok, no) {
    var c = [];
    req.on('data', function(d) { c.push(d); });
    req.on('end', function() { ok(Buffer.concat(c)); });
    req.on('error', no);
  });
}

function getMime(f) {
  var e = (f || '').split('.').pop().toLowerCase();
  return {
    rbxm:'application/xml', rbxmx:'application/xml',
    png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg',
    mp3:'audio/mpeg', ogg:'audio/ogg',
    fbx:'model/fbx', obj:'model/obj'
  }[e] || 'application/octet-stream';
}

function getType(f) {
  var e = (f || '').split('.').pop().toLowerCase();
  return {
    rbxm:'Model', rbxmx:'Model',
    png:'Decal', jpg:'Decal', jpeg:'Decal',
    mp3:'Audio', ogg:'Audio',
    fbx:'MeshPart', obj:'MeshPart'
  }[e] || 'Model';
}

function extractParts(buf, boundary) {
  var result = { fields: {}, file: null };
  var bBytes = Buffer.from('--' + boundary);
  var positions = [];
  var offset = 0;

  while (true) {
    var pos = buf.indexOf(bBytes, offset);
    if (pos === -1) break;
    positions.push(pos);
    offset = pos + bBytes.length;
  }

  for (var i = 0; i < positions.length - 1; i++) {
    var start = positions[i] + bBytes.length;
    var end = positions[i + 1];
    var chunk = buf.slice(start, end);

    if (chunk[0] === 0x2D && chunk[1] === 0x2D) continue;
    if (chunk[0] === 0x0D) chunk = chunk.slice(2);

    var headerEnd = -1;
    for (var j = 0; j < chunk.length - 3; j++) {
      if (chunk[j]===0x0D && chunk[j+1]===0x0A && chunk[j+2]===0x0D && chunk[j+3]===0x0A) {
        headerEnd = j;
        break;
      }
    }
    if (headerEnd === -1) continue;

    var headerStr = chunk.slice(0, headerEnd).toString('utf8');
    var body = chunk.slice(headerEnd + 4);

    if (body.length >= 2 && body[body.length-2]===0x0D && body[body.length-1]===0x0A) {
      body = body.slice(0, body.length - 2);
    }

    var nm = headerStr.match(/name="([^"]+)"/);
    if (!nm) continue;

    var fn = headerStr.match(/filename="([^"]+)"/);

    if (fn) {
      result.file = {
        filename: fn[1],
        buffer: body
      };
    } else {
      result.fields[nm[1]] = body.toString('utf8');
    }
  }

  return result;
}

module.exports = function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-action');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  return getRawBody(req).then(function(raw) {
    if (!raw || raw.length === 0) {
      return res.status(400).json({ error: 'Empty body received' });
    }

    var action = req.headers['x-action'];

    // ====== VERIFY ======
    if (action === 'verify-user') {
      var data;
      try { data = JSON.parse(raw.toString()); }
      catch(e) { return res.status(400).json({ error: 'Bad JSON: ' + e.message }); }

      if (!data.userId || !data.apiKey) return res.status(400).json({ error: 'Missing fields' });
      if (!/^\d+$/.test(data.userId)) return res.status(400).json({ error: 'User ID must be number' });

      return fetch('https://users.roblox.com/v1/users/' + data.userId)
      .then(function(r) {
        if (!r.ok) throw new Error('User not found');
        return r.json();
      })
      .then(function(u) {
        if (u.isBanned) throw new Error('User is banned');

        return fetch('https://apis.roblox.com/assets/v1/assets', {
          headers: { 'x-api-key': data.apiKey }
        }).then(function(kr) {
          var kv = true, ke = null;
          if (kr.status === 401) { kv = false; ke = 'Invalid API Key'; }
          if (kr.status === 403) { kv = false; ke = 'Missing permissions'; }
          return res.status(200).json({
            valid: true,
            displayName: u.displayName || u.name,
            keyValid: kv,
            keyError: ke
          });
        }).catch(function() {
          return res.status(200).json({
            valid: true,
            displayName: u.displayName || u.name,
            keyValid: true,
            keyError: null
          });
        });
      })
      .catch(function(e) {
        return res.status(400).json({ error: e.message });
      });
    }

    // ====== UPLOAD ======
    var ct = req.headers['content-type'] || '';
    var bm = ct.match(/boundary=([^\s;]+)/);
    if (!bm) return res.status(400).json({ error: 'No boundary' });

    var parsed = extractParts(raw, bm[1]);
    var fields = parsed.fields;
    var file = parsed.file;

    if (!fields.userId || !fields.apiKey) return res.status(400).json({ error: 'Missing credentials' });
    if (!file) return res.status(400).json({ error: 'No file' });

    var rType = getType(file.filename);
    var mime = getMime(file.filename);
    var dName = (fields.displayName || 'Asset').substring(0, 50);
    var desc = (fields.description || 'Uploaded').substring(0, 1000);

    var reqBody = {
      assetType: rType,
      displayName: dName,
      description: desc,
      creationContext: { creator: { userId: fields.userId } }
    };

    var fd = new FormData();
    fd.append('request', JSON.stringify(reqBody), {
      contentType: 'application/json',
      filename: 'request.json'
    });
    fd.append('fileContent', file.buffer, {
      filename: file.filename,
      contentType: mime
    });

    var h = { 'x-api-key': fields.apiKey };
    var fh = fd.getHeaders();
    Object.keys(fh).forEach(function(k) { h[k] = fh[k]; });

    return fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST', headers: h, body: fd
    })
    .then(function(ur) {
      return ur.text().then(function(rt) {
        var rd;
        try { rd = JSON.parse(rt); } catch(e) { rd = { raw: rt }; }

        if (!ur.ok) {
          var msg = rd.message || rd.error || 'Error ' + ur.status;
          if (ur.status === 401) msg = 'Invalid API Key';
          if (ur.status === 403) msg = 'Missing permissions';
          if (ur.status === 429) msg = 'Rate limited';
          return res.status(ur.status).json({ error: msg });
        }

        var aid = rd.assetId || (rd.response && rd.response.assetId) || null;

        if (!aid && rd.path) {
          return poll(rd.path, fields.apiKey, 0).then(function(id) {
            return res.status(200).json({
              success: true, assetId: id,
              toolboxUrl: id ? 'https://www.roblox.com/library/' + id : null,
              insertUrl: id ? 'rbxassetid://' + id : null
            });
          });
        }

        return res.status(200).json({
          success: true, assetId: aid,
          toolboxUrl: aid ? 'https://www.roblox.com/library/' + aid : null,
          insertUrl: aid ? 'rbxassetid://' + aid : null
        });
      });
    })
    .catch(function(e) {
      return res.status(500).json({ error: e.message });
    });

  }).catch(function(e) {
    return res.status(500).json({ error: 'Server: ' + e.message });
  });
};

function poll(path, key, n) {
  if (n >= 10) return Promise.resolve(null);
  return new Promise(function(r) { setTimeout(r, 2000); })
  .then(function() {
    return fetch('https://apis.roblox.com/assets/v1/' + path, {
      headers: { 'x-api-key': key }
    });
  })
  .then(function(r) {
    if (!r.ok) return poll(path, key, n + 1);
    return r.json().then(function(d) {
      if (d.done) return d.response && d.response.assetId;
      return poll(path, key, n + 1);
    });
  })
  .catch(function() { return poll(path, key, n + 1); });
}

module.exports.config = {
  api: { bodyParser: false }
};
