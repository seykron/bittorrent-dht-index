var Bittorrent = require("../lib/bittorrent");
var async = require("async");
var bittorrent = new Bittorrent();

var conn = bittorrent.connect("127.0.0.1:51413",
  "a82713780b7a2e50422ad7384cf5aff731412dd7");

conn.on("connect", function () {
  conn.newTransaction()
    .extendedHandshake()
    .unchoke()
//    .interested()
    .metadata()
    .execute()
    .then(function (result) {
      console.log(result);
    }, function (error) {
      console.log(error);
    });
});
conn.on("error", function (err) {
  console.log(err);
});
conn.on("close", function () {
  console.log("connection closed.");
});
