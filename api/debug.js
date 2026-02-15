module.exports = function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') return res.status(200).end();

  var ct = req.headers['content-type'] || 'none';
  var cl = req.headers['content-length'] || 'none';

  var chunks = [];
  req.on('data', function(c) { chunks.push(c); });
  req.on('end', function() {
    var buf = Buffer.concat(chunks);
    res.status(200).json({
      method: req.method,
      contentType: ct,
      contentLength: cl,
      bodySize: buf.length,
      hasBody: buf.length > 0,
      first100: buf.toString('utf8', 0, 100)
    });
  });
};

module.exports.config = {
  api: { bodyParser: false }
};
