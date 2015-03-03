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

  /** Timeout to wait for a peer to receive metadata for an infohash, in
   milliseconds. */
  var FETCH_METADATA_TIMEOUT = 5000;

  /** Utility to encode messages using the bencode protocol. See:
    https://en.wikipedia.org/wiki/Bencoding */
  var bencode = require("bencode");

  /** Generates random hashes. */
  var hat = require("hat");

  /** Node's UDP library. */
  var dgram = require("dgram");

  /** Node's network library. */
  var net = require("net");

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

  /** Creates the bittorrent handshake message (BEP 03).
   * @param {String} nodeId Id of the querying node. Cannot be null.
   * @param {String} infoHash Infohash required to start a connection to the
   *    peer.
   * @return {Buffer} Returns the encoded handshake message as a buffer.
   */
  var createHandshakeMessage = function (nodeId, infoHash) {
    var protocol = new Buffer('\u0013BitTorrent protocol')
    var reserved = new Buffer(8);
    var message;

    reserved[5] |= 0x10; // enable extended message
    reserved[7] |= 1; // enable DHT.

    // Message: "handshake" <pstrlen><pstr><reserved><info_hash><peer_id>
    message = Buffer.concat([protocol, reserved,
      new Buffer(infoHash, "hex"), new Buffer(nodeId, "hex")]);

    return message;
  };

  /** Handles the handshake message from a peer.
   * @param {String} infoHash Infohash related to the connection. Cannot be
   *    null or empty.
   * @param {Buffer} message Message buffer received from the peer. Cannot be
   *    null.
   * @return {Boolean} Returns true if the handshake message is valid and it
   *    supports the DHT (BEP 05) and the extension protocol (BEP 010), false
   *    otherwise.
   */
  var handleHandshakeMessage = function (infoHash, message) {
    var pstrlen = message.readUInt8(0);
    var protocol = message.slice(1, pstrlen + 1);
    var handshakeInfo;
    var incomingInfoHash;
    var extensions;

    if (protocol.toString() !== "BitTorrent protocol") {
      debug("handshake error: invalid BitTorrent protocol (%s %s)",
        pstrlen, protocol.toString());
      return false;
    }

    handshakeInfo = message.slice(pstrlen + 1);
    incomingInfoHash = handshakeInfo.slice(8, 28).toString("hex");
    extensions = {
      dht: !!(handshakeInfo[7] & 0x01), // see bep_0005
      extended: !!(handshakeInfo[5] & 0x10) // see bep_0010
    };

    if (incomingInfoHash.toLowerCase() !== infoHash.toLowerCase()) {
      debug("handshake error: invalid infohash %s", incomingInfoHash);
      return false;
    }

    if (!extensions.extended) {
      debug("handshake error: peer doesn't support metadata extension");
      return false;
    }

    debug("handshake accepted for %s", infoHash);

    return true;
  };

  /** Creates the message for the extended protocol (BEP 10) and encapsultes a
   * specific extension message.
   *
   * @param {Object} message Custom message contained in the extension protocol.
   *    Cannot be null.
   * @return {Buffer} Returns the extension protocol (BEP 10) message.
   */
  var createExtendedMessage = function (message) {
    var encodedMessage = bencode.encode(message);
    // <uint32 size><uint8 message id><uint8 extended message id><payload>
    var size = 6 + encodedMessage.length;
    var message = new Buffer(6);

    // Full message length.
    message.writeUInt32BE(size, 0);

    // 20 is the identifier for BEP 10 messages.
    message.writeUInt8(0x14, 4);

    // Extended message id. 0 means the handshake message.
    message.writeUInt8(0, 5);

    // Appends the bencoded message payload.
    return Buffer.concat([message, encodedMessage]);
  };

  /** Creates the message to ask for metadata (BEP 09).
   * @param {Number} piece Required metadata piece. Cannot be null.
   * @return {Buffer} Returns a valid message to ask for metadata.
   */
  var createMetadataMessage = function (piece) {
    return createExtendedMessage({
      msg_type: 0,
      piece: piece,
      m: {
        ut_metadata: 1
      }
    });
  };

  /** Handles a metadata message.
   * @param {Buffer} message Bittorrent metadata message (BEP 09). Cannot be
   *    null.
   * @return {Object} Returns an object containing metadata information.
   */
  var handleMetadataMessage = function (message) {
    var metadataMessage = bencode.decode(message);

    // TODO(seykron): implement the key part.
    return null;
  };

  /** Fetches metadata for an infohash from the specified peer. It assumes the
   * peer does support the bittorrent metadata extension (BEP 09).
   *
   * @param {String} nodeId Id from the querying node. Cannot be null or empty.
   * @param {String} peer host:port address of the peer. Cannot be null or
   *    empty.
   * @param {String} infoHash Infohash to query metadata. Cannot be null or
   *    empty.
   * @param {Function} callback Receives an error and an object containing the
   *    required metadata. Cannot be null.
   */
  var fetchMetadata = function (nodeId, peer, infoHash, callback) {
    var host = peer.substr(0, peer.indexOf(":"));
    var port = parseInt(peer.substr(peer.indexOf(":") + 1), 10);
    var handshake = true;
    var error;

    var conn = net.connect({
      host: host,
      port: port
    }, function () {
      // First we must perform the initial handshake according to BEP 03.
      debug("sending handshake from node %s to peer %s", nodeId, peer);
      conn.write(createHandshakeMessage(nodeId, infoHash));
    });
    conn.on("data", function (data) {
      var length;
      var messageCode;

      if (handshake) {
        if (handleHandshakeMessage(infoHash, data)) {
          // Initial handshake succeed, we ask for the metadata using the
          // ut_metadata extension (BEP 09).
          handshake = false;
          conn.write(createMetadataMessage());
        } else {
          conn.destroy();
        }
      } else {
        // Another message than handshake received.
        length = data.readUInt32BE(0);
        messageCode = data.readUInt8(4);

        debug("received message %s from %s", messageCode, peer);

        // According to BEP 03, 0 means a keep alive message and it is send
        // every two minutes. We ignore it since two minutes is enough time to
        // retrieve the metadata.
        if (length > 0) {
          if (messageCode === 20) {
            debug("received metadata message from %s", peer);

            conn.destroy();
            callback(null, handleMetadataMessage(data.slice(6)));
          } else {
            debug("received unhandled message %s from %s", messageCode, peer);
          }
        }
      }
    });
    conn.on("error", function (err) {
      debug("error connecting to peer %s: %s", peer, err);
      error = err;
      conn.destroy();
    });
    conn.on("close", function () {
      if (error) {
        callback(new Error("connection closed"));
      }
    });
    conn.setTimeout(FETCH_METADATA_TIMEOUT, function () {
      debug("connection timeout");
      error = new Error("connection timeout");
      conn.destroy();
    });
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

    fetchMetadata: fetchMetadata,

    getNodeId: function () {
      return NODE_ID;
    }
  });
};
