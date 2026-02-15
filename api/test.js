var fetch = require('node-fetch');

module.exports = function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');

  var uid = req.query.uid || '1';

  fetch('https://users.roblox.com/v1/users/' + uid)
  .then(function(r) { return r.json(); })
  .then(function(d) {
    res.status(200).json({
      works: true,
      robloxResponse: d
    });
  })
  .catch(function(e) {
    res.status(200).json({
      works: false,
      error: e.message
    });
  });
};
