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
    var ct = req.headers['content-type'] || '';
    var bm = ct.match(/boundary=([^\s;]+)/);
    if (!bm) return res.status(400).json({ error: 'No boundary' });

    var parts = parseParts(buf, bm[1]);

    var fileInfo = null;
    if (parts.file) {
      fileInfo = {
        filename: parts.file.filename,
        size: parts.file.data.length,
        first20hex: parts.file.data.slice(0, 20).toString('hex'),
        first50text: parts.file.data.slice(0, 50).toString('utf8')
      };
    }

    // Show what we WOULD send to Roblox
    var userId = parts.fields.userId || 'none';
    var apiKey = parts.fields.apiKey || 'none';
    var assetType = parts.fields.assetType || 'Model';
    var displayName = parts.fields.displayName || 'Asset';

    var typeMap = { Model: 'Model', Decal: 'Decal', Audio: 'Audio', Mesh: 'MeshPart' };
    var rType = typeMap[assetType] || 'Model';
    var mime = guessMime(parts.file ? parts.file.filename : '');

    var reqJson = JSON.stringify({
      assetType: rType,
      displayName: displayName,
      description: 'test',
      creationContext: { creator: { userId: userId } }
    });

    var B = '----RobloxUpload' + Date.now();

    var part1 = '--' + B + '\r\n' +
      'Content-Disposition: form-data; name="request"; filename="request.json"\r\n' +
      'Content-Type: application/json\r\n' +
      '\r\n' +
      reqJson + '\r\n';

    var part2header = '--' + B + '\r\n' +
      'Content-Disposition: form-data; name="fileContent"; filename="' + (parts.file ? parts.file.filename : 'none') + '"\r\n' +
      'Content-Type: ' + mime + '\r\n' +
      '\r\n';

    var ending = '\r\n--' + B + '--\r\n';

    var totalSize = Buffer.byteLength(part1) + Buffer.byteLength(part2header) + (parts.file ? parts.file.data.length : 0) + Buffer.byteLength(ending);

    res.status(200).json({
      parsed: {
        fields: parts.fields,
        file: fileInfo
      },
      wouldSend: {
        boundary: B,
        part1: part1,
        part2header: part2header,
        fileSize: parts.file ? parts.file.data.length : 0,
        ending: ending,
        totalBodySize: totalSize,
        hasApiKey: apiKey.length > 10
      }
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
  for (var i = 0; i < positions.length - 1; i++) {
    var start = positions[i] + bBuf.length;
    if (buf[start] === 0x2D && buf[start+1] === 0x2D) continue;
    if (buf[start] === 0x0D && buf[start+1] === 0x0A) start += 2;
    var end = positions[i+1];
    if (end >= 2 && buf[end-2] === 0x0D && buf[end-1] === 0x0A) end -= 2;
    var part = buf.slice(start, end);
    var si = findBuf(part, sep, 0);
    if (si === -1) continue;
    var head = part.slice(0, si).toString('utf8');
    var body = part.slice(si + 4);
    var nm = head.match(/name="([^"]+)"/);
    if (!nm) continue;
    var fn = head.match(/filename="([^"]+)"/);
    if (fn) { result.file = { filename: fn[1], data: body }; }
    else { result.fields[nm[1]] = body.toString('utf8'); }
  }
  return result;
}

function findBuf(buf, search, from) {
  for (var i = from; i <= buf.length - search.length; i++) {
    var ok = true;
    for (var j = 0; j < search.length; j++) {
      if (buf[i+j] !== search[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

function guessMime(f) {
  var e = (f || '').split('.').pop().toLowerCase();
  return { rbxm:'application/xml', rbxmx:'application/xml', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', mp3:'audio/mpeg', ogg:'audio/ogg' }[e] || 'application/octet-stream';
}

module.exports.config = { api: { bodyParser: false } };
