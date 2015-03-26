/** Gossip-like validation protocol to let new nodes join a distributed network.
 * It works like this:
 *
 * 1. New nodes must ask a seed node in order to join the network.
 *
 * 2. The seed node sends gossip messages to validation nodes that already exist
 * in the network and they store the gossip messages for a while.
 *
 * 3. The seed node asks the new node to ping the validation nodes in order to
 * ask for any gossip message related to the underlying transaction.
 *
 * 4. Once the new node receives the gossip messages from the validation nodes,
 * it sends the messages to the seed node for validation.
 *
 * 5. If the seed node successfully validates the messages, it asks the
 * validation nodes to accept the new node as a known peer, and it tells the
 * new node to connect to the validation nodes.
 *
 * When a node acts as validation node, it must listen for the
 * <code>accept</code> event in order to handle new peers.
 *
 * When a node acts as joining node, it must listen for the
 * <code>connectto</code> event in order to join the network through the
 * provided nodes.
 */
module.exports = function Gossip(nodeData, options) {

  /** Port to listen for connections. */
  var BIND_PORT = options && options.bindPort || 7410;

  /** Address of the interface to listen for connections. */
  var BIND_ADDRESS = options && options.bindAddress || "127.0.0.1";

  /** Seed node to join the network. */
  var SEED_NODE = options && options.seed || {
    address: "127.0.0.1",
    port: 7410
  };

  /** Expiration time, in milliseconds, of gossip transactions. Default is
  5 minutes. */
  var GOSSIP_MESSAGE_EXPIRATION = 60 * 5 * 1000;

  /** Signature used to recognize a handshake message. */
  var HEADER_SIGNATURE = "Gossip Validation Protocol";

  /** Current gossip protocol instance. */
  var gossip = this;

  /** Node's network API. */
  var net = require("net");

  /** Class logger. */
  var debug = require("debug")("gossip-" + BIND_PORT);

  /** Utility to manage asynchronous operations. */
  var async = require("async");

  /** Utility to compose mixins. */
  var extend = require("extend");

  /** Generates random ids. */
  var hat = require("hat");

  /** Bittorrent encode library. */
  var bencode = require("bencode");

  /** Utility to convert bittorrent "compact" addresses to host:port format. */
  var compact2string = require("compact2string");

  /** Utility to convert host:port to bittorrent "compact" addresses. */
  var string2compact = require("string2compact");

  /** Node's event emitter utility. */
  var EventEmitter = require("events").EventEmitter;

  /** Server to listen for client requests, it's never null after init() if this
  node is configured as a seed. */
  var server;

  /** Stores gossip messages until the joining node asks for it. The message
  is discarded after GOSSIP_MESSAGE_EXPIRATION. */
  var gossipMessages = {};

  /** Gossip validation protocol messages. */
  var ProtocolMessages = {

    /** There is a protocol error. It is sent any time there's a problem
      processing a protocol message.
    */
    ERROR: 0,

    /** Ask a seed node to join the network. The message data must be the
     bencoded custom data of the node that wants to join the network. The
     response message data must be a bencoded list of objects containing the
     compact address of a validation node and a transaction identifier.
    */
    JOIN: 1,

    /** Sends a "gossip" message to a validation node in order to wait for a new
     node ping message. The message data could be any random data generated
     by a seed node and the custom data of the new node.
    */
    GOSSIP: 2,

    /** Pings a vaidation node to retrieve the gossip message for the underlying
     transaction. New nodes must ping validation nodes provided by a seed in
     order to validate itself and join the network. The message data must be a
     bencoded object containing the transaction id provided by the seed node.
     The response must be bencoded object containing the transaction id provided
     by the seed node and the gossip data.
    */
    PING: 3,

    /** Sends to the seed node the gossip data provided by existing nodes. The
     message data is a bencoded list of objects containing the transaction id
     previously provided by the seed for the underlying node and the node's
     gossip data. The response from a seed node must be a bencoded object
     containing the list of host configurations to establish the connection
    */
    PONG: 4,

    /** Tells a validation node it must accept a new node. The message must be
      the bencoded custom data from the new node.
     */
    ACCEPT: 5
  };

  /** Creates a protocol message.
   *
   * @param {Number} messageType Protocol message type. Cannot be null.
   * @param {String} transactionId Id of the transaction this message belongs
   *   to. Cannot be null or empty.
   * @param {Object} data Message data. Cannot be null.
   * @return {Buffer} Returns the encoded message, never null.
   */
  var createMessage = function (messageType, transactionId, data) {
    var signatureLength = HEADER_SIGNATURE.length;
    var header = new Buffer(signatureLength + 8);

    // Message format:
    // <signt-length><signature><transactionId:4><messageType:2><bencoded-data>
    header.writeInt8(signatureLength, 0);
    header.write(HEADER_SIGNATURE, 1);
    header.writeInt32BE(transactionId, signatureLength + 2);
    header.writeInt16BE(messageType, signatureLength + 6);

    return Buffer.concat([header, bencode.encode(data)]);
  };

  /** Parses a protocol message.
   * @param {Buffer} data Protcol message data. Cannot be null.
   * @return {Object} Returns the decoded message, never null.
   */
  var parseMessage = function (data) {
    var signatureLength = data.readInt8(0);
    var signature = data.slice(1, signatureLength + 1).toString();
    var transactionId = data.readInt32BE(signatureLength + 2);
    var messageType = data.readInt16BE(signatureLength + 6);
    var body;

    if (!signature || signature !== HEADER_SIGNATURE) {
      debug("invalid message header %s", signature);
      return null;
    }

    if (!transactionId) {
      debug("invalid transaction id");
      return null;
    }

    if (!messageType) {
      debug("invalid message type");
      return null;
    }

    if (data.length > signatureLength + 8) {
      body = bencode.decode(data.slice(signatureLength + 8));
    }

    return {
      transactionId: transactionId,
      type: messageType,
      body: body
    };
  };

  /** Transforms a bittorrent compact address to an object.
   *
   * @param {Buffer|String} compactAddress Compact address to convert. Cannot be
   *    null.
   * @return {Object} An object containing the address and the port, never null.
   */
  var compact2Node = function (compactAddress) {
    var addressInfo = compact2string(compactAddress);

    return {
      address: addressInfo.substr(0, addressInfo.indexOf(":")),
      port: addressInfo.substr(addressInfo.indexOf(":") + 1)
    };
  };

  /** Creates a transaction to send and receive messages.
   * @param {net.Socket} socket Socket to send and receive messages. Cannot
   *    be null.
   * @param {String} transactionId A random id to identify this transaction.
   *    Cannot be null or empty.
   * @return {Object} Returns a transaction object, never null.
   */
  var createTransaction = function (socket, transactionId) {
    var id = transactionId || null;
    var transaction = {};

    socket.on("data", function (data) {
      var message = parseMessage(data);

      if (!message) {
        transaction.emit(ProtocolMessages.ERROR,
          new Error("invalid message"));
        return;
      }

      if (id && message.transactionId !== id) {
        transaction.emit(ProtocolMessages.ERROR,
          new Error("received message with invalid transaction id."));
        return;
      }

      debug("data received from %s:%s", socket.remoteAddress,
        socket.remotePort);
      transaction.emit(message.type, message);
    });
    socket.on("close", function () {
      transaction.emit("close");
    });
    socket.on("error", function (err) {
      transaction.emit(ProtocolMessages.ERROR, err);
    });

    return extend(transaction, new EventEmitter(), {

      /** Returns the transaction identifier.
       * @return {String} a valid transaction id, never null or empty.
       */
      getId: function () {
        return id;
      },

      /** Sets the transaction id.
       * @param {String} theId Transaction id. Cannot be null.
       */
      setId: function (theId) {
        id = theId;
      },

      /** Sends a message from this transaction.
       * @param {Number} messageType Protocol message type to send. Cannot be
       *    null.
       * @param {Object} data Data to send. Cannot be null.
       */
      send: function (messageType, data) {
        socket.write(createMessage(messageType, id, data));
      },

      /** Closes this transaction and the underlying connection.
       */
      close: function () {
        socket.end();
      },

      /** Sends an error message from this transaction.
       * @param {Object} err Error object. Cannot be null.
       */
      error: function (err) {
        var errorMessage = createMessage(ProtocolMessages.ERROR, id,
          err || new Error("unknown error"));

        // Sends the error message and then destroy the socket.
        socket.write(errorMessage, function () {
          socket.destroy();
        });
      }
    });
  };

  /** Creates a connection to the specified host.
   * @param {String} address Address to connect to. Cannot be null.
   * @param {Number} port Target host port number. Cannot be null.
   */
  var connect = function (address, port, callback) {
    var transactionId = Math.floor(Math.random() * Math.pow(2, 12));
    var socket = net.connect({
      host: address,
      port: port
    }, function () {
      debug("connection to %s:%s established", address, port);
      callback(createTransaction(socket, transactionId))
    });
  };

  /** Handles a JOIN message. It sends the GOSSIP message to the validation
   * nodes and once they received the message it sends a response back to the
   * joining node.
   *
   * @param {Object} transaction Underlying transaction. Cannot be null.
   * @param {Object} message Protocol message. Cannot be null.
   */
  var handleJoinRequest = function (transaction, message) {
    // TODO(seykron): peek up nodes randomly. The local node is hardcoded
    // because it is a proof of concept.
    var validationNodes = options.validationNodes || [{
      address: "127.0.0.1",
      port: BIND_PORT
    }];
    var responseData = [];
    var gossipData = new Buffer(hat(24), "hex");

    // Prepares tasks to send the gossip message to each validation node.
    var gossipTasks = validationNodes.map(function (validationNode) {
      var address = validationNode.address;
      var port = validationNode.port;

      return function sendGossipRequest(callback) {
        connect(address, port, function (nestedTransaction) {
          var gossipMessage = {
            transactionId: nestedTransaction.getId(),
            data: gossipData
          };

          debug("sending gossip message to %s:%s within transaction %s",
            address, port, nestedTransaction.getId());

          // Adds the validation node and the underlying transaction id to the
          // response.
          responseData.push({
            transactionId: nestedTransaction.getId(),
            address: string2compact(address + ":" + port)
          });

          // Sends the gossip message to a single validation node.
          nestedTransaction.send(ProtocolMessages.GOSSIP, gossipMessage);

          // Waits for the GOSSIP message response.
          nestedTransaction.on(ProtocolMessages.GOSSIP, function (response) {
            // Adds the gossip message to the parent transaction in
            // order to validate it later when it receives a PONG request.
            transaction.validations.push({
              node: validationNode,
              nodeData: response.body,
              message: gossipMessage
            });
          });

          nestedTransaction.on("close", callback);
        });
      };
    });

    // List of object containing information about pending validations.
    transaction.validations = [];
    // Saves the new node specific data within the transaction.
    transaction.nodeData = message.body;

    async.series(gossipTasks, function (err, results) {

      debug("sending join response for transaction %s", transaction.getId());

      transaction.send(ProtocolMessages.JOIN, responseData);
    });
  };

  /** It handles the GOSSIP protocol message. It stores the gossip message for
   * a while waiting for a PING request form a joining node.
   *
   * @param {Object} transaction Underlying transaction. Cannot be null.
   * @param {Object} message Protocol message. Cannot be null.
   */
  var handleGossipRequest = function (transaction, message) {
    debug("received gossip message %s from transaction %s",
      message.body.data.toString("hex"), transaction.getId());

    gossipMessages[message.body.transactionId] = message.body;

    // Waits until the gossip data expires and then removes it from the
    // table.
    setTimeout(function () {
      delete gossipMessages[message.transactionId];
    }, GOSSIP_MESSAGE_EXPIRATION);

    transaction.send(ProtocolMessages.GOSSIP, nodeData);
    transaction.close();
  };

  /** Sends a PING protocol message to a validation node.
   *
   * @param {Object} transaction Underlying transaction. Cannot be null.
   * @param {Object} node Validation node address information. Cannot be null.
   * @param {String} gossipTransactionId Id of the gossip transaction provided
   *    by the seed node. Cannot be null or empty.
   */
  var sendPingRequest = function (transaction, node, gossipTransactionId) {
    connect(node.address, node.port, function (nestedTransaction) {
      debug("sending ping request to %s:%s within transaction %s",
        node.address, node.port, nestedTransaction.getId());

      nestedTransaction.send(ProtocolMessages.PING, {
        transactionId: gossipTransactionId
      });
      nestedTransaction.on(ProtocolMessages.PING, function (message) {
        // Delegates the response to the parent transaction.
        transaction.emit(ProtocolMessages.PING, message);
      });
    });
  };

  /** Handles a PING message. If the transaction has a related gossip message
   * it is returned back to the querying node.
   *
   * @param {Object} transaction Underlying transaction. Cannot be null.
   * @param {Object} message Protocol message. Cannot be null.
   */
  var handlePingRequest = function (transaction, message) {
    var transactionId = message.body.transactionId;
    var data = transactionId && gossipMessages[transactionId];

    if (!transactionId || !gossipMessages.hasOwnProperty(transactionId)) {
      transaction.error(new Error("unknown transaction " + transactionId));
      return;
    }

    delete gossipMessages[transactionId];

    transaction.send(ProtocolMessages.PING, data);
  };

  /** Sends the ACCEPT protocol message to a node. It is sent by a seed node
   * when it receives a valid PONG message from a new node.
   *
   * @param {Object} node Node address information. Cannot be null.
   * @param {Object} transaction Underlying transaction. Cannot be null.
   */
  var sendAcceptRequest = function (node, transaction) {
    connect(node.address, node.port, function (nestedTransaction) {
      nestedTransaction.send(ProtocolMessages.ACCEPT, transaction.nodeData);
    });
  };

  /** Handles the ACCEPT message.
   * @param {Object} transaction Underlying transaction. Cannot be null.
   * @param {Object} message Protocol message. Cannot be null.
   */
  var handleAcceptRequest = function (transaction, message) {
    gossip.emit("accept", message.body);
    transaction.close();
  };

  /** Handles the PONG message. It validates gossip messages and sends the
   * ACCEPT message if possible.
   *
   * @param {Object} transaction Underlying transaction. Cannot be null.
   * @param {Object} message Protocol message. Cannot be null.
   */
  var handlePongRequest = function (transaction, message) {
    var pingResponses = message.body;

    // Validates the stored gossip messages for this transaction against the
    // gossip message provided by the new node.
    var valid = pingResponses.every(function (pingResponse) {
      return transaction.validations.some(function (validation) {
        var valMessage = validation.message;

        return valMessage.transactionId === pingResponse.transactionId &&
          valMessage.data.toString("hex") === pingResponse.data.toString("hex");
      });
    });
    var responseData = [];

    debug("received PONG request: %s", JSON.stringify(message));

    if (valid) {
      // Sends the ACCEPT message to validation nodes.
      transaction.validations.forEach(function (validation) {
        responseData.push({
          address: string2compact(validation.node.address + ":" +
            validation.node.port),
          data: validation.nodeData
        });
        sendAcceptRequest(validation.node, transaction);
      });

      transaction.send(ProtocolMessages.PONG, responseData);
      transaction.close();
    } else {
      transaction.error(new Error("validation failed"));
    }
  };

  /** Initializes the transaction for server-side messages.
   * @param {Object} transaction Transaction to initialize. Cannot be null.
   */
  var initServerTransaction = function (transaction) {

    // Received by a seed node when a new node wants to join the network.
    transaction.on(ProtocolMessages.JOIN, function (message) {
      // Initializes the transaction id since it is provided by
      // the incoming connection.
      transaction.setId(message.transactionId);
      handleJoinRequest(transaction, message);
    });

    // Received when a seed node sends a GOSSIP message.
    transaction.on(ProtocolMessages.GOSSIP, function (message) {
      transaction.setId(message.transactionId);
      handleGossipRequest(transaction, message);
    });

    // Received when a new node asks for gossip data during
    // the validation process.
    transaction.on(ProtocolMessages.PING, function (message) {
      transaction.setId(message.transactionId);
      handlePingRequest(transaction, message);
    });

    // Received by a seed node when the new node sends the gossip data provided
    // by validation nodes.
    transaction.on(ProtocolMessages.PONG, function (message) {
      transaction.setId(message.transactionId);
      handlePongRequest(transaction, message);
    });

    // Received by validation nodes when a seed node sucessfully
    // validated a new node.
    transaction.on(ProtocolMessages.ACCEPT, function (message) {
      transaction.setId(message.transactionId);
      handleAcceptRequest(transaction, message);
    });
  };

  /** Initializes the client-side transaction.
   * @param {Object} transaction Transaction to initialize. Cannot be null.
   */
  var initClientTransaction = function (transaction) {
    // Number of pending responses for PING messages.
    var pingRequestsCount;

    // Stores the received ping responses.
    var pingResponses = [];

    // Received as a response to the JOIN message.
    transaction.on(ProtocolMessages.JOIN, function (message) {
      var validationNodes = message.body;

      pingRequestsCount = validationNodes.length;

      validationNodes.forEach(function (nodeInfo) {
        sendPingRequest(transaction, compact2Node(nodeInfo.address),
          nodeInfo.transactionId);
      });
    });

    // Received as a response to the PING message.
    transaction.on(ProtocolMessages.PING, function (message) {
      pingResponses.push(message.body);

      if (pingResponses.length === pingRequestsCount) {
        // All ping responses received, it sends the PONG message to the seed
        // node.
        transaction.send(ProtocolMessages.PONG, pingResponses);
      }
    });

    // Received as a response to the PONG message.
    transaction.on(ProtocolMessages.PONG, function (message) {
      var nodes = message.body.map(function (node) {
        return {
          node: compact2Node(node.address),
          data: node.data
        };
      });

      gossip.emit("connectto", nodes);
    });
  };

  // Constructor method.
  (function __initialize() {
    // Creates the server to listen for server-side messages.
    server = net.createServer(function (socket) {
      var transaction = createTransaction(socket);

      debug("new connection from %s:%s", socket.remoteAddress,
        socket.remotePort);

      initServerTransaction(transaction);
    });
    server.listen(BIND_PORT, BIND_ADDRESS, function () {
      debug("seed node listening on port %s", BIND_PORT);
      gossip.emit("ready");
    });
  }());

  return extend(gossip, new EventEmitter(), {

    /** Joins the network and sends the custom data to the validation nodes.
     */
    join: function () {
      connect(SEED_NODE.address, SEED_NODE.port, function (transaction) {
        initClientTransaction(transaction);
        transaction.send(ProtocolMessages.JOIN, nodeData);
      });
    }
  });
};
