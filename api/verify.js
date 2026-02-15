var fetch = require('node-fetch');

module.exports = function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') return res.status(200).end();

  var uid = req.query.uid || '';
  var key = req.query.key || '';

  if (!uid) return res.status(400).json({ error: 'Add ?uid=YOUR_ID&key=YOUR_KEY' });

  fetch('https://users.roblox.com/v1/users/' + uid)
  .then(function(r) {
    if (!r.ok) throw new Error('User not found');
    return r.json();
  })
  .then(function(u) {
    if (u.isBanned) throw new Error('Banned');
    return res.status(200).json({
      valid: true,
      displayName: u.displayName || u.name,
      userId: uid
    });
  })
  .catch(function(e) {
    return res.status(400).json({ error: e.message });
  });
};
