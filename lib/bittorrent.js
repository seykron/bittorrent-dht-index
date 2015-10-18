/** Low-level implementation of the bittorrent protocol (BEP 03).
 */
module.exports = function Bittorrent() {

  /** Timeout to wait for a peer to receive metadata for an infohash, in
   milliseconds. */
  var FETCH_METADATA_TIMEOUT = 5000;

  /** Signature that identifies the BT protocol. */
  var PROTOCOL_SIGNATURE = "BitTorrent protocol";

  var MESSAGE_EXTENDED = 0x14;
  var MESSAGE_UT_METADATA = 0x3;

  /** Utility to extend objects. */
  var extend = require("extend");

  /** Node's event manager utility. */
  var EventEmitter = require("events").EventEmitter;

  /** Current protocol instance, it is an event emitter. */
  var bittorrent = extend(this, new EventEmitter());

  /** Node's network library. */
  var net = require("net");

  /** Prints debug messages for this instance, it is never null. */
  var debug = require("debug")("bittorrent");

  /** Utility to generate random ids. */
  var hat = require("hat");

  var bencode = require("bencode");

  var MessageBuilder = require("./MessageBuilder");

  var async = require("async");

  var Promise = require("promise");

  /** Active connections. */
  var connections = {};

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

  /** Creates the message to ask for metadata (BEP 09).
   * @param {Number} piece Required metadata piece. Cannot be null.
   * @return {Buffer} Returns a valid message to ask for metadata.
   */
  var createMetadataMessage = function (piece) {
    return createExtendedMessage({
      msg_type: 0,
      piece: piece,
      m: {
        ut_metadata: 3
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


  var MessageHandlers = {
    0: function (transaction, message) {
      transaction.emit("choke");
    },
    1: function (transaction, message) {
      transaction.emit("unchoke");
    },
    // MESSAGE_EXTENDED
    20: function (transaction, message) {

    }
  };

  var createDefaultChannel = function (messageType) {
    return {
      accepts: function (message) {
        return message.type === messageType;
      },
      push: function (message) {
        debug("Message %s received", messageType);
      },
      closed: function () {
        return true;
      }
    };
  };

  var Channels = {
    0: function (response) {
      return createDefaultChannel(0);
    },
    1: function (response) {
      return createDefaultChannel(1);
    },
    // MESSAGE_EXTENDED
    20: function (response) {
      var closed = false;

      return {
        accepts: function (message) {
          return message.type === MESSAGE_EXTENDED &&
            message.data.extendedId >= 0;
        },
        push: function (message) {
          // handshake
          if (message.extendedId === 0) {
            response.extendedHandshake = message.data;
          }
        },
        closed: function () {
          return closed;
        }
      };
    }
  };

  var readMessage = function (data) {
    var pstrlen = data.readUInt8(0);
    var protocol = data.slice(1, pstrlen + 1).toString();
    var size;
    var message;
    var payload;

    debug(data.toString())
    if (protocol === PROTOCOL_SIGNATURE) {
      message = {
        type: "handshake",
        handshake: true,
        data: protocol
      };
    } else {
      size = data.readUInt32BE(0);
      message = {
        type: data.readUInt8(4),
        handshake: false
      };
      if (message.type === MESSAGE_EXTENDED) {
        message.extendedId = data.readUInt8(5);
        payload = data.slice(6);
      } else {
        payload = data.slice(5);
      }
      // Skips keep-alive messages.
      if (payload.length > 0 && payload.readUInt8(0) > 0) {
        payload = bencode.decode(payload);
      }
      message.data = payload;
    }

    return message;
  };

  var createTransaction = function (socket, messageBuilder, callback) {
    var messageQueue = [];
    var response = {};
    var transaction = new Promise(function (resolve, reject) {
      messageBuilder.each(function (message, next) {
        debug("sending message %s: %s", message.name,
          message.data.toString("ascii"));
        messageQueue.push(extend(message, {
          next: next
        }));
        socket.write(message.data);
      }, function (err) {
        if (err) {
          reject(err);
        } else {
          resolve("results");
        }
      });
    });

    return extend(transaction, {
      isActive: function () {
        return true;
      },
      handle: function (message) {
        Channels[message.type](response);
        console.log(message);
        if (messageQueue.length > 0) {
          messageQueue.shift().next();
        }
      }
    });
  };

  /** Connects to the specified peer and creates a transaction to start
   * sending protocol messages between peers.
   *
   * @param {String} nodeId Id from the querying node. Cannot be null or empty.
   * @param {String} peer host:port address of the peer. Cannot be null or
   *    empty.
   * @param {String} infoHash Infohash related to this transaction. Cannot be
   *    null or empty.
   */
  var createConnection = function (nodeId, peer, infoHash) {
    var connection = extend(this, new EventEmitter());
    var host = peer.substr(0, peer.indexOf(":"));
    var port = parseInt(peer.substr(peer.indexOf(":") + 1), 10);
    var error;
    var connectionId;
    var socket;
    var activeTransaction;

    (function __init() {
      while (!connectionId || connections.hasOwnProperty(connectionId)) {
        connectionId = Math.floor(Math.random() * Math.pow(2, 12));
      }

      socket = net.connect({
        host: host,
        port: port
      }, function () {
        socket.write(new MessageBuilder(nodeId, infoHash)
          .handshake().build());
      });
      socket.on("error", function (err) {
        debug("error connecting to peer %s: %s", peer, err);
        connection.emit("error", err);
      });
      socket.on("close", function () {
        connection.emit("close");
      });
      socket.on("data", function (data) {
        debug("data received", data.toString());
        var message = readMessage(data);
        var valid = message.handshake || (message.handshake === false &&
          Channels.hasOwnProperty(message.type));

        if (!valid) {
          debug("invalid message '%s' received: %s", message.type,
            message.data.toString("ascii"));
          return;
        }

        debug("received message %", JSON.stringify(message));

        if (message.handshake) {
          connection.emit("connect");
          return;
        }

        if (activeTransaction.isActive()) {
          activeTransaction.handle(message);
        } else {
          debug("no transaction to handle message: %s",
            JSON.stringify(message));
        }
      });
/*      socket.setTimeout(FETCH_METADATA_TIMEOUT, function () {
        debug("connection timeout");
        error = new Error("connection timeout");
        socket.destroy();
      });*/
    }());

    return extend(connection, {
      nodeId: nodeId,
      peer: peer,
      infoHash: infoHash,
      newTransaction: function () {
        var messageBuilder = new MessageBuilder(nodeId, infoHash);

        return extend(messageBuilder, {
          execute: function () {
            activeTransaction = createTransaction(socket, messageBuilder);
            return activeTransaction;
          }
        });
      }
    });
  };

  return extend(bittorrent, {
    connect: function (peer, infoHash) {
      // Custom node id for this connection and the next requests.
      var nodeId = hat(160);
      return createConnection(nodeId, peer, infoHash);
    }
  });
};
