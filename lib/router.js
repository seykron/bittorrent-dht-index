/** Router node for the Bittorrent DHT network. It allows to handle DHT messages
 * and forwards all unhandled messages to the uTorrent router. Read the
 * bittorrent DHT protocol for further information:
 * http://www.bittorrent.org/beps/bep_0005.html
 *
 * It also retrieves metadata information from peers using the bittorrent
 * metadata extension. Look at the following protocols for further information:
 *
 * Bittorrent protocol: http://www.bittorrent.org/beps/bep_0003.html
 * Extension protocol: http://www.bittorrent.org/beps/bep_0010.html
 * Metadata extension protocol: http://www.bittorrent.org/beps/bep_0009.html
 */
module.exports = function Router(config) {

  /** Utility to extend objects. */
  var extend = require("extend");

  /** Node's event manager utility. */
  var EventEmitter = require("events").EventEmitter;

  /** Current router instance, it is an event emitter. */
  var router = extend(this, new EventEmitter());

  /** Node to forward queries when they cannot be handled by this router. */
  var FORWARD_NODE = (config && config.forwardNode) || {
    address: "router.utorrent.com",
    port: 6881
  };

  /** The received message is a query. */
  var MESSAGE_QUERY = "q";

  /** The received message is a response. */
  var MESSAGE_RESPONSE = "r";

  /** The received message is an error. */
  var MESSAGE_ERROR = "e";

  /** UDP port to listen for messages. */
  var BIND_PORT = (config && config.bindPort) || 6881;

  /** Utility to encode messages using the bencode protocol. See:
    https://en.wikipedia.org/wiki/Bencoding */
  var bencode = require("bencode");

  /** Generates random hashes. */
  var hat = require("hat");

  /** Node's UDP library. */
  var dgram = require("dgram");

  /** Prints debug messages for this instance, it is never null. */
  var debug = require("debug")("router");

  /** Unique id for this node instance. */
  var NODE_ID = hat(160);

  /** Keeps the transactions being processed and the underlying host. */
  var transactions = {};

  /** UDP socket to receive and send messages, it is never null. */
  var socket = dgram.createSocket('udp4');

  /** Reads the transaction id from the specified message.
   * @return {Number} Returns the message transaction id, never null.
   */
  var getTransactionId = function (message) {
    return Buffer.isBuffer(message.t) && message.t.length === 2
        && message.t.readUInt16BE(0);
  };

  /** Sends a DHT request to the specified node.
   * @param {Number} transactionId Id of the related transaction, following
   *    the rules of the spec. Cannot be null.
   * @param {Object} targetNode Address and port information of the target node.
   *    Cannot be null.
   * @param {String} messageType Type of the message, according to the spec.
   *    Cannot be null or empty.
   * @param {Object} data Message specific data. Cannot be null.
   */
  var sendMessage = function (transactionId, targetNode, messageType, data) {
    var id = new Buffer(2);
    var message;
    var data;

    id.writeUInt16BE(transactionId, 0);
    message = extend({}, data, {
      t: id,
      y: messageType
    });
    data = bencode.encode(message);

    delete transactions[transactionId];

    debug("sending message to %s:%s : %s", targetNode.address, targetNode.port,
      JSON.stringify(message));
    socket.send(data, 0, data.length, targetNode.port, targetNode.address);
  };

  /** Handles a DHT message.
   * @param {Object} node Node that sent the message. Cannot be null.
   * @param {Object} message Valid DHT message. Cannot be null.
   * @return {Boolean} Returns true if the message was handled, false otherwise.
   */
  var handleMessage = function (node, message) {
    var transactionId = getTransactionId(message);
    var messageType = message.y.toString();

    switch (messageType) {
      case MESSAGE_ERROR:
        debug("received 'error' message from %s:%s for transaction %s",
          node.address, node.port, transactionId);
        return router.emit("error", node, transactionId, message.e);
      case MESSAGE_RESPONSE:
        debug("received 'response' message from %s:%s for transaction %s",
          node.address, node.port, transactionId);
        return router.emit("response", node, transactionId, message.r);
      case MESSAGE_QUERY:
        debug("received query from %s:%s for transaction %s",
          node.address, node.port, transactionId);

        return router.emit(message.q, node, message.a, function (err, res) {
          if (err) {
            // Error processing the query.
            sendMessage(transactionId, targetNode, MESSAGE_ERROR, {
              e: [code, errorMessage]
            });
          } else {
            // Sends a query response.
            sendMessage(transactionId, node, MESSAGE_RESPONSE, {
              r: res
            });
          }
        });
    }

    return false;
  };

  /* Constructor method. */
  (function __initialize() {

    // Ping messages are handled by the router itself.
    router.on("ping", function (node, params, callback) {
      process.nextTick(function () {
        callback(null, {
          id: NODE_ID
        });
      });
    });

    socket.on('message', function (data, rinfo) {
      var message = bencode.decode(data);
      var transactionId = getTransactionId(message);
      var transaction = transactions[transactionId];
      var forwardNode = FORWARD_NODE;

      // If the message is not a reply from a forwarded message, it forwards
      // the message to the proxy.
      if (!handleMessage(rinfo, message)) {

        if (transaction && transaction.forward) {
          // It is an unhandled message from a forward, the message is
          // forwarded back to the original node.
          forwardNode = transaction.host;
          delete transactions[transactionId];
        } else {
          // Saves the current transaction.
          transactions[transactionId] = {
            host: rinfo,
            forward: true
          };
        }

        // Forwards all unhandled messages to the fallback server.
        debug("forwarding to %s:%s", forwardNode.address, forwardNode.port);

        socket.send(data, 0, data.length, forwardNode.port,
          forwardNode.address);
      }
    });
  }());

  return extend(router, {
    init: function (callback) {
      debug("listening for connections on port %s", BIND_PORT);

      socket.bind(BIND_PORT, callback);
    },

    query: function (node, transactionId, queryName, params) {
      var data = {
        q: queryName,
        a: params
      };
      sendMessage(transactionId, node, MESSAGE_QUERY, data);
    },

    getNodeId: function () {
      return NODE_ID;
    }
  });
};
