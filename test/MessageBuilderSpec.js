/**
Bittorrent protocol: http://www.bittorrent.org/beps/bep_0003.html
Bittorrent messages:
  0 - choke
  1 - unchoke
  2 - interested
  3 - not interested
  4 - have
  5 - bitfield
  6 - request
  7 - piece
  8 - cancel
 */
describe("MessageBuilderTest", function () {
  var debug = require("debug")("message_builder");
  var hat = require("hat");
  var bencode = require("bencode");
  var MessageBuilder = require("../lib/MessageBuilder");
  var messageBuilder;
  var nodeId = hat(160);
  var infoHash = "A3B8EFE116B63B78356FCFBD086E7131941E5D71";

  beforeEach(function () {
    process.env.DEBUG = (process.env.DEBUG || "") +
      " message_builder_test message_builder";

    messageBuilder = new MessageBuilder(nodeId, infoHash);
  });

  it("must create a valid handshake message", function () {
    messageBuilder.handshake().each(function (message, next) {
      var data = message.data;

      expect(data.length).toBe(68);
      expect(message.name).toBe("handshake");
      expect(data.slice(1, data.readUInt8(0) + 1).toString())
        .toBe("BitTorrent protocol");
      expect(data.slice(28, 48).toString("hex").toUpperCase())
        .toBe(infoHash);
      expect(data.slice(48, 68).toString("hex")).toBe(nodeId);
      next();
    });
  });
  it("must create a valid choke message", function () {
    messageBuilder.choke().each(function (message, next) {
      var data = message.data;

      expect(data.length).toBe(5);
      expect(message.name).toBe("choke");
      expect(data.readUInt32BE(0)).toBe(5);
      expect(data.readUInt8(4)).toBe(0);
      next();
    });
  });
  it("must create a valid unchoke message", function () {
    messageBuilder.unchoke().each(function (message, next) {
      var data = message.data;

      expect(data.length).toBe(5);
      expect(message.name).toBe("unchoke");
      expect(data.readUInt32BE(0)).toBe(5);
      expect(data.readUInt8(4)).toBe(1);
      next();
    });
  });
  it("must create a valid interested message", function () {
    messageBuilder.interested().each(function (message, next) {
      var data = message.data;

      expect(data.length).toBe(5);
      expect(message.name).toBe("interested");
      expect(data.readUInt32BE(0)).toBe(5);
      expect(data.readUInt8(4)).toBe(2);
      next();
    });
  });
  it("must create a valid not_interested message", function () {
    messageBuilder.notInterested().each(function (message, next) {
      var data = message.data;

      expect(data.length).toBe(5);
      expect(message.name).toBe("notInterested");
      expect(data.readUInt32BE(0)).toBe(5);
      expect(data.readUInt8(4)).toBe(3);
      next();
    });
  });
  it("must create a valid extended handshake message", function () {
    var payload = {
      ut_metadata: 3
    };

    messageBuilder.extendedHandshake(payload).each(function (message, next) {
      var data = message.data;
      var size = data.readUInt32BE(0);
      var resultPayload = bencode.decode(data.slice(6, size));

      expect(message.name).toBe("extendedHandshake");
      expect(data.readUInt8(4)).toBe(20);
      expect(data.readUInt8(5)).toBe(0);
      expect(JSON.stringify(resultPayload)).toEqual(JSON.stringify({
        m: payload
      }));
      next();
    });
  });
});
