var https = require('https');

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

    if (buf.length === 0) {
      return res.status(400).json({ error: 'Empty body' });
    }

    var ct = req.headers['content-type'] || '';
    var bm = ct.match(/boundary=([^\s;]+)/);
    if (!bm) {
      return res.status(400).json({ error: 'No boundary' });
    }

    var parts = parseParts(buf, bm[1]);

    if (!parts.file) {
      return res.status(400).json({
        error: 'No file found',
        fields: Object.keys(parts.fields),
        bodySize: buf.length
      });
    }

    var userId = parts.fields.userId || '';
    var apiKey = parts.fields.apiKey || '';
    if (!userId || !apiKey) {
      return res.status(400).json({ error: 'Missing userId or apiKey' });
    }

    var assetType = parts.fields.assetType || 'Model';
    var displayName = (parts.fields.displayName || 'Asset').substring(0, 50);
    var description = (parts.fields.description || 'Uploaded').substring(0, 1000);

    var typeMap = {
      Model: 'Model',
      Decal: 'Decal',
      Audio: 'Audio',
      Mesh: 'MeshPart'
    };
    var rType = typeMap[assetType] || guessType(parts.file.filename);
    var mime = guessMime(parts.file.filename);

    var reqJson = JSON.stringify({
      assetType: rType,
      displayName: displayName,
      description: description,
      creationContext: {
        creator: {
          userId: userId
        }
      }
    });

    var B = '----RobloxUpload' + Date.now();

    var bodyParts = [];
    bodyParts.push(Buffer.from(
      '--' + B + '\r\n' +
      'Content-Disposition: form-data; name="request"; filename="request.json"\r\n' +
      'Content-Type: application/json\r\n' +
      '\r\n' +
      reqJson + '\r\n'
    ));
    bodyParts.push(Buffer.from(
      '--' + B + '\r\n' +
      'Content-Disposition: form-data; name="fileContent"; filename="' + parts.file.filename + '"\r\n' +
      'Content-Type: ' + mime + '\r\n' +
      '\r\n'
    ));
    bodyParts.push(parts.file.data);
    bodyParts.push(Buffer.from('\r\n--' + B + '--\r\n'));

    var fullBody = Buffer.concat(bodyParts);

    var options = {
      hostname: 'apis.roblox.com',
      path: '/assets/v1/assets',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'multipart/form-data; boundary=' + B,
        'Content-Length': fullBody.length
      }
    };

    var robloxReq = https.request(options, function(robloxRes) {
      var data = '';
      robloxRes.on('data', function(ch) { data += ch; });
      robloxRes.on('end', function() {
        var rd;
        try {
          rd = JSON.parse(data);
        } catch(e) {
          rd = { raw: data };
        }

        if (robloxRes.statusCode < 200 || robloxRes.statusCode >= 300) {
          var msg = rd.message || rd.error || 'Error ' + robloxRes.statusCode;
          if (robloxRes.statusCode === 401) msg = 'Invalid API Key';
          if (robloxRes.statusCode === 403) msg = 'Missing permissions - need Assets Read+Write and IP 0.0.0.0/0';
          if (robloxRes.statusCode === 429) msg = 'Rate limited - wait 1 min';
          return res.status(robloxRes.statusCode).json({ error: msg, details: rd });
        }

        var aid = null;
        if (rd.assetId) {
          aid = rd.assetId;
        }
        if (rd.response && rd.response.assetId) {
          aid = rd.response.assetId;
        }

        if (!aid && rd.path) {
          pollOp(rd.path, apiKey, 0, function(id) {
            return res.status(200).json({
              success: true,
              assetId: id,
              toolboxUrl: id ? 'https://www.roblox.com/library/' + id : null,
              insertUrl: id ? 'rbxassetid://' + id : null
            });
          });
          return;
        }

        return res.status(200).json({
          success: true,
          assetId: aid,
          toolboxUrl: aid ? 'https://www.roblox.com/library/' + aid : null,
          insertUrl: aid ? 'rbxassetid://' + aid : null
        });
      });
    });

    robloxReq.on('error', function(e) {
      return res.status(500).json({ error: 'Request failed: ' + e.message });
    });

    robloxReq.write(fullBody);
    robloxReq.end();
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
    if (buf[start] === 0x2D && buf[start + 1] === 0x2D) {
      continue;
    }
    if (buf[start] === 0x0D && buf[start + 1] === 0x0A) {
      start = start + 2;
    }

    var end = positions[i + 1];
    if (end >= 2 && buf[end - 2] === 0x0D && buf[end - 1] === 0x0A) {
      end = end - 2;
    }

    var part = buf.slice(start, end);
    var si = findBuf(part, sep, 0);
    if (si === -1) {
      continue;
    }

    var head = part.slice(0, si).toString('utf8');
    var body = part.slice(si + 4);

    var nm = head.match(/name="([^"]+)"/);
    if (!nm) {
      continue;
    }

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
      if (buf[i + j] !== search[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function guessMime(f) {
  var e = (f || '').split('.').pop().toLowerCase();
  var map = {
    rbxm: 'application/xml',
    rbxmx: 'application/xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    fbx: 'model/fbx',
    obj: 'model/obj'
  };
  return map[e] || 'application/octet-stream';
}

function guessType(f) {
  var e = (f || '').split('.').pop().toLowerCase();
  var map = {
    rbxm: 'Model',
    rbxmx: 'Model',
    png: 'Decal',
    jpg: 'Decal',
    jpeg: 'Decal',
    mp3: 'Audio',
    ogg: 'Audio',
    fbx: 'MeshPart',
    obj: 'MeshPart'
  };
  return map[e] || 'Model';
}

function pollOp(path, key, n, cb) {
  if (n >= 10) {
    return cb(null);
  }
  setTimeout(function() {
    https.get({
      hostname: 'apis.roblox.com',
      path: '/assets/v1/' + path,
      headers: { 'x-api-key': key }
    }, function(r) {
      var d = '';
      r.on('data', function(c) { d += c; });
      r.on('end', function() {
        try {
          var pd = JSON.parse(d);
          if (pd.done) {
            var id = null;
            if (pd.response && pd.response.assetId) {
              id = pd.response.assetId;
            }
            return cb(id);
          }
          pollOp(path, key, n + 1, cb);
        } catch(e) {
          pollOp(path, key, n + 1, cb);
        }
      });
    }).on('error', function() {
      pollOp(path, key, n + 1, cb);
    });
  }, 2000);
}

module.exports.config = {
  api: { bodyParser: false }
};
