var express = require('express');
var models = require('./models');
var l10n = require('./l10n');

var app = express();

app.use(function(req, resp, next) {
  if (req.hostname == 'ntustudents.org') {
    resp.header('Access-Control-Allow-Origin', req.hostname);
    resp.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  }
  next();
});

app.get('/', function(req, resp) {
  resp.json({ hello: 'world' });
});

app.get('/mission/list', function(req, resp) {
  resp.json({ msg: 'WIP' });
});

app.get('/rank', function(req, resp) {
  var limit = 100;
  if (req.query.limit) {
    req.query.limit = req.query.limit - 0;
    if (req.query.limit > 0 && req.query.limit < 100)
      limit = req.query.limit;
    else
      return resp.status(400).json({ ok: false, msg: 'invalid limit' });
  }

  models.User.findAll({
    order: [['score', 'DESC']],
    limit: limit,
    attributes: ['fb_id', 'avatar', 'score', 'updated_at', 'team_id']
  }).then(function(records) {
    var result = records.map((v) => v.dataValues);
    resp.json({ ok: true, data: result });
  });
});

module.exports = app;
