var fetch = require('node-fetch');
var FormData = require('form-data');

function getRawBody(req) {
  if (req.body && Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body);
  }
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return Promise.resolve(Buffer.from(JSON.stringify(req.body)));
  }
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(c) { chunks.push(c); });
    req.on('end', function() { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function extractParts(buf, boundary) {
  var results = { fields: {}, file: null };
  var bStr = '--' + boundary;
  var full = buf.toString('binary');
  var pieces = full.split(bStr);

  for (var i = 1; i < pieces.length; i++) {
    var piece = pieces[i];
    if (piece.indexOf('--') === 0) break;

    var divider = '\r\n\r\n';
    var idx = piece.indexOf(divider);
    if (idx === -1) continue;

    var head = piece.substring(0, idx);
    var val = piece.substring(idx + 4);

    if (val.endsWith('\r\n')) {
      val = val.substring(0, val.length - 2);
    }

    var nm = head.match(/name="([^"]+)"/);
    if (!nm) continue;

    var fn = head.match(/filename="([^"]+)"/);

    if (fn) {
      var headBuf = Buffer.from(head, 'binary');
      var bodyStart = buf.indexOf(headBuf) + headBuf.length + 4;
      var nextBoundary = buf.indexOf(Buffer.from('\r\n' + bStr, 'binary'), bodyStart);
      if (nextBoundary === -1) nextBoundary = buf.indexOf(Buffer.from(bStr, 'binary'), bodyStart);

      results.file = {
        name: nm[1],
        filename: fn[1],
        buffer: buf.slice(bodyStart, nextBoundary)
      };
    } else {
      results.fields[nm[1]] = val;
    }
  }

  return results;
}

function getMime(f) {
  var ext = (f || '').split('.').pop().toLowerCase();
  var m = {
    rbxm: 'application/xml', rbxmx: 'application/xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    mp3: 'audio/mpeg', ogg: 'audio/ogg',
    fbx: 'model/fbx', obj: 'model/obj'
  };
  return m[ext] || 'application/octet-stream';
}

function getType(f) {
  var ext = (f || '').split('.').pop().toLowerCase();
  var m = {
    rbxm: 'Model', rbxmx: 'Model',
    png: 'Decal', jpg: 'Decal', jpeg: 'Decal',
    mp3: 'Audio', ogg: 'Audio',
    fbx: 'MeshPart', obj: 'MeshPart'
  };
  return m[ext] || 'Model';
}

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-action');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  return getRawBody(req).then(function(rawBody) {
    var action = req.headers['x-action'];

    // ====== VERIFY ======
    if (action === 'verify-user') {
      var data;
      try {
        data = JSON.parse(rawBody.toString());
      } catch(e) {
        return res.status(400).json({ error: 'Invalid JSON' });
      }

      var userId = data.userId;
      var apiKey = data.apiKey;

      if (!userId || !apiKey) return res.status(400).json({ error: 'Missing fields' });
      if (!/^\d+$/.test(userId)) return res.status(400).json({ error: 'User ID must be number' });

      return fetch('https://users.roblox.com/v1/users/' + userId)
        .then(function(ur) {
          if (!ur.ok) throw new Error('User not found');
          return ur.json();
        })
        .then(function(ud) {
          if (ud.isBanned) throw new Error('User is banned');

          return fetch('https://apis.roblox.com/assets/v1/assets', {
            headers: { 'x-api-key': apiKey }
          })
          .then(function(kr) {
            var keyValid = true;
            var keyError = null;
            if (kr.status === 401) { keyValid = false; keyError = 'Invalid API Key'; }
            if (kr.status === 403) { keyValid = false; keyError = 'Missing permissions'; }

            return res.status(200).json({
              valid: true,
              displayName: ud.displayName || ud.name,
              keyValid: keyValid,
              keyError: keyError
            });
          })
          .catch(function() {
            return res.status(200).json({
              valid: true,
              displayName: ud.displayName || ud.name,
              keyValid: true,
              keyError: null
            });
          });
        })
        .catch(function(err) {
          return res.status(400).json({ error: err.message });
        });
    }

    // ====== UPLOAD ======
    var ct = req.headers['content-type'] || '';
    var bm = ct.match(/boundary=([^\s;]+)/);
    if (!bm) return res.status(400).json({ error: 'No boundary found' });

    var parsed = extractParts(rawBody, bm[1]);
    var fields = parsed.fields;
    var file = parsed.file;

    if (!fields.userId || !fields.apiKey) return res.status(400).json({ error: 'Missing credentials' });
    if (!file || !file.buffer || file.buffer.length === 0) return res.status(400).json({ error: 'No file uploaded' });

    var rType = getType(file.filename);
    var mime = getMime(file.filename);
    var dName = (fields.displayName || 'Asset').substring(0, 50);
    var desc = (fields.description || 'Uploaded via converter').substring(0, 1000);

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

    var headers = { 'x-api-key': fields.apiKey };
    var fdHeaders = fd.getHeaders();
    Object.keys(fdHeaders).forEach(function(k) { headers[k] = fdHeaders[k]; });

    return fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST',
      headers: headers,
      body: fd
    })
    .then(function(ur) {
      return ur.text().then(function(rt) {
        var rd;
        try { rd = JSON.parse(rt); } catch(e) { rd = { raw: rt }; }

        if (!ur.ok) {
          var msg = rd.message || rd.error || 'Error ' + ur.status;
          if (ur.status === 401) msg = 'Invalid API Key';
          if (ur.status === 403) msg = 'Missing permissions - add Assets Read+Write and IP 0.0.0.0/0';
          if (ur.status === 429) msg = 'Rate limited - wait 1 min';
          return res.status(ur.status).json({ error: msg });
        }

        var assetId = rd.assetId || (rd.response && rd.response.assetId) || null;

        if (!assetId && rd.path) {
          return pollOperation(rd.path, fields.apiKey, 0, rd)
            .then(function(result) {
              return res.status(200).json({
                success: true,
                assetId: result.assetId,
                toolboxUrl: result.assetId ? 'https://www.roblox.com/library/' + result.assetId : null,
                insertUrl: result.assetId ? 'rbxassetid://' + result.assetId : null
              });
            });
        }

        return res.status(200).json({
          success: true,
          assetId: assetId,
          toolboxUrl: assetId ? 'https://www.roblox.com/library/' + assetId : null,
          insertUrl: assetId ? 'rbxassetid://' + assetId : null
        });
      });
    })
    .catch(function(err) {
      return res.status(500).json({ error: err.message });
    });

  }).catch(function(err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  });
};

function pollOperation(path, apiKey, attempt, lastData) {
  if (attempt >= 10) {
    var aid = null;
    var paths = [
      lastData.response && lastData.response.path,
      lastData.path
    ].filter(Boolean);
    for (var i = 0; i < paths.length; i++) {
      var m = paths[i].match(/assets\/(\d+)/);
      if (m) { aid = m[1]; break; }
    }
    return Promise.resolve({ assetId: aid });
  }

  return new Promise(function(resolve) {
    setTimeout(resolve, 2000);
  }).then(function() {
    return fetch('https://apis.roblox.com/assets/v1/' + path, {
      headers: { 'x-api-key': apiKey }
    });
  }).then(function(pr) {
    if (!pr.ok) return pollOperation(path, apiKey, attempt + 1, lastData);
    return pr.json().then(function(pd) {
      if (pd.done) {
        return { assetId: pd.response && pd.response.assetId };
      }
      return pollOperation(path, apiKey, attempt + 1, pd);
    });
  }).catch(function() {
    return pollOperation(path, apiKey, attempt + 1, lastData);
  });
}

module.exports.config = {
  api: { bodyParser: false }
};
