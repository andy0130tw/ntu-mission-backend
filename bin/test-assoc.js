#!/usr/bin/env node

var models = require('../models');

models.User.findOne({
    where: { id: {$gt: 0} },
    // include: [models.Post]
}).then(function(rec) {
    console.log(rec.dataValues);
    // for (var x in rec) {
    //     if (x.indexOf('get') == 0 && x != 'getDataValue' && x != 'get') {
    //         console.log(x);
    //         rec[x]().then(function(subrec) {
    //             console.log(subrec.map((v)=>v.dataValues));
    //         });
    //     }
    // }
});
