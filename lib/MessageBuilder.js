/** Bittorrent protocol message builder and parser.
 */
module.exports = function MessageBuilder(nodeId, infoHash) {
  var MESSAGE_CHOKE = 0x0;
  var MESSAGE_UNCHOKE = 0x1;
  var MESSAGE_INTERESTED = 0x2;
  var MESSAGE_NOT_INTERESTED = 0x3;
  var MESSAGE_EXTENDED = 0x14;

  var debug = require("debug")("message_builder");
  var bencode = require("bencode");
  var async = require("async");

  var queue = [];

  var addMessage = function (name, data) {
    debug("adding message %s to the queue: %s", name, data);
    queue.push({
      name: name,
      data: data
    });
  };

  var buildMessage = function (messageId, data) {
    // <uint32 size><uint8 message id><payload>
    var size = 5 + ((data && data.length) || 0);
    var message = new Buffer(5);

    // Full message length.
    message.writeUInt32BE(size, 0);

    // Message id.
    message.writeUInt8(messageId, 4);

    // Appends the bencoded payload.
    if (data && data.length > 0) {
      return Buffer.concat([message, data]);
    } else {
      return message;
    }
  };

  var buildExtensionMessage = function (extendedMessageId, data) {
    var size = (data && data.length) || 0;

    // <uint32 size><uint8 extended message id><payload>
    var message = new Buffer(6);

    message.writeUInt32BE(6 + size, 0);
    message.writeUInt8(MESSAGE_EXTENDED, 4);

    // Extended message id. 0 means the handshake message.
    message.writeUInt8(extendedMessageId, 5);

    if (size > 0) {
      // Appends the bencoded message payload.
      return Buffer.concat([message, data]);
    } else {
      // Only handshake message allows optional payload.
      return message;
    }
  };

  return {
    handshake: function () {
      var protocol = new Buffer('\u0013BitTorrent protocol')
      var reserved = new Buffer(8);
      var message;

      reserved[5] |= 0x10; // enable extended message
      reserved[7] |= 1; // enable DHT.

      // Message: "handshake" <pstrlen><pstr><reserved><info_hash><peer_id>
      message = Buffer.concat([protocol, reserved,
        new Buffer(infoHash, "hex"), new Buffer(nodeId, "hex")]);

      addMessage("handshake", message);

      return this;
    },

    choke: function () {
      addMessage("choke", buildMessage(MESSAGE_CHOKE));
      return this;
    },

    unchoke: function () {
      addMessage("unchoke", buildMessage(MESSAGE_UNCHOKE));
      return this;
    },

    interested: function () {
      addMessage("interested", buildMessage(MESSAGE_INTERESTED));
      return this;
    },

    notInterested: function () {
      addMessage("notInterested", buildMessage(MESSAGE_NOT_INTERESTED));
      return this;
    },

    extendedHandshake: function (extensions) {
      addMessage("extendedHandshake", buildExtensionMessage(0));
      return this;
    },

    metadata: function () {
      var payload = {
        piece: 0,
        msg_type: 0
      };
      addMessage("ut_metadata", buildExtensionMessage(3,
        bencode.encode(payload)));
      return this;
    },

    each: function (iterator, done) {
      async.eachSeries(queue, iterator, function (err) {
        done(err);
      });
    },

    build: function () {
      var firstMessage = queue.shift();

      return queue.reduce(function (prev, message) {
        console.log("foo")
        if (prev) {
          return Buffer.concat(prev, message.data);
        } else {
          return message.data;
        }
      }, firstMessage && firstMessage.data)
    }
  };
};
