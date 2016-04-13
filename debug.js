var express = require('express');
var models = require('./models');

var app = express();

app.get('/', function(req, resp) {
  resp.render('debug_view_home');
});

app.get('/missions', function(req, resp) {
  models.Mission.findAll().then(function(records) {
    var result = records.map(function(v) {
      return v.dataValues;
    });

    resp.render('debug_view_general', {
      title: 'Mission List',
      dataset: result,
      __MISSIONS: 1
    });
  });
});

app.get('/users', function(req, resp) {
  models.User.findAll({
    order: [['score', 'DESC']]
  }).then(function(records) {
    var result = records.map(function(v, i) {
      v.dataValues.__cnt = i + 1;
      return v.dataValues;
    });

    resp.render('debug_view_general', {
      title: 'User List',
      dataset: result,
      __USERS: 1
    });
  });
});

app.get('/log', function(req, resp) {
  models.Post.findAll({
    order: [['fb_ts', 'DESC']]
  }).then(function(records) {
    var result = records.map(function(v, i) {
      var dv = v.dataValues;
      if (dv.content) {
        dv.__content = dv.content.replace(/\n/g, '<br>');
      }
      return dv;
    });

    resp.render('debug_view_general', {
      title: 'Log',
      dataset: result,
      __LOG: 1
    });
  });
});

module.exports = app;
