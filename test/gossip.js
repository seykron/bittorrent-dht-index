process.env.DEBUG = (process.env.DEBUG || "") + " gossip_test";

var Gossip = require("../lib/gossip");
var debug = require("debug")("gossip_test");

var node1 = new Gossip({ data: "foo"}, {
  bindPort: 7777
});
var node2 = new Gossip({ data: "bar" }, {
  bindPort: 7778
});
var seed = new Gossip({ data: "seed" }, {
  validationNodes: [{
    address: "127.0.0.1",
    port: 7778
  }, {
    address: "127.0.0.1",
    port: 7777
  }]
});

node1.on("accept", function (nodeData) {
  debug("node1 accept %s", JSON.stringify(nodeData));
});
node1.on("connectto", function (nodes) {
  debug("node1 connect foo to %s", JSON.stringify(nodes));
});
node2.on("accept", function (nodeData) {
  debug("node2 accept %s", JSON.stringify(nodeData));
});
node2.on("connectto", function (nodes) {
  debug("node2 connect bar to %s", JSON.stringify(nodes));
});

node1.join();
node2.join();
