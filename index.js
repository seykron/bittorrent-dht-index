var Queue = require("./lib/queue");
var Crawler = require("./lib/crawler");

//var queue = new Queue("data");
var queue = {
  get: function (count, callback) {
    process.nextTick(function () {
      callback(null, ["7f7408a0030e22d8713bd30b545db22fce6c0dd0"])
    });
  }
};
var crawler = new Crawler(queue);

crawler.on("torrent", (infoHash, torrent, done) => {
  console.log("Got torrent for ", infoHash, JSON.stringify(torrent));
  done();
});

crawler.start();
