function leftPad(s, n) {
  s = s + '';
  while (s.length < n) s = '0' + s;
  return s;
}

module.exports = {
  extname: '.hbs',
  helpers: {
    date: function(d) {
      return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' '
         + leftPad(d.getHours(),   2) + ':'
         + leftPad(d.getMinutes(), 2) + ':'
         + leftPad(d.getSeconds(), 2);
    }
  }
};
