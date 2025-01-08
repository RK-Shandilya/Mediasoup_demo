import mediasoup from "mediasoup";
import WebSocket, { WebSocketServer } from "ws";
import { createServer } from "http";
import { v4 as uuid } from "uuid";
import { mediasoupOptions } from "./config/mediasoupConfig.js";

const PORT = 3001;
const server = createServer();
const wss = new WebSocketServer({ server });

let worker = null;
let router = null;
const peers = new Map();
const transports = {};
const producers = {};
const consumers = {};

(async () => {
  worker = await mediasoup.createWorker();
  router = await worker.createRouter({ mediaCodecs: mediasoupOptions.mediaCodecs });
  console.log("Router created");
})();

wss.on("connection", (ws) => {
  const id = uuid();
  peers.set(id, ws);

  // Send router RTP capabilities to the connected client
  ws.send(
    JSON.stringify({
      action: "routerRtpCapabilities",
      data: { peerId: id, routerRtpCapabilities: router.rtpCapabilities },
    })
  );

  ws.on("message", async (message) => {
    const { action, data } = JSON.parse(message);

    switch (action) {
      case "createProducerTransport": {
        const transport = await createWebrtcTransport();
        transports[id] = { producerTransport: transport };

        ws.send(
          JSON.stringify({
            action: "producerTransportCreated",
            data: {
              id: transport.id,
              iceParameters: transport.iceParameters,
              iceCandidates: transport.iceCandidates,
              dtlsParameters: transport.dtlsParameters,
            },
          })
        );
        break;
      }

      case "connectProducerTransport": {
        await transports[id].producerTransport.connect({ dtlsParameters: data.dtlsParameters });
        break;
      }

      case "produce": {
        const { kind, rtpParameters } = data;

        const producer = await transports[id].producerTransport.produce({ kind, rtpParameters });
        producers[producer.id] = { producer, peerId: id };

        ws.send(
          JSON.stringify({
            action: "producerCreated",
            data: { id: producer.id },
          })
        );

        // Notify other peers about the new producer
        broadcast(ws, {
          action: "newProducer",
          data: { producerId: producer.id },
        });
        break;
      }

      case "createConsumerTransport": {
        const transport = await createWebrtcTransport();
        if (!transports[id]) transports[id] = {};
        transports[id].consumerTransport = transport;

        ws.send(
          JSON.stringify({
            action: "consumerTransportCreated",
            data: {
              id: transport.id,
              iceParameters: transport.iceParameters,
              iceCandidates: transport.iceCandidates,
              dtlsParameters: transport.dtlsParameters,
            },
          })
        );
        break;
      }

      case "connectConsumerTransport": {
        await transports[id].consumerTransport.connect({ dtlsParameters: data.dtlsParameters });
        break;
      }

      case "consume": {

        const { producerId, rtpCapabilities } = data;
        console.log("rtpCapabilities", rtpCapabilities);

        const producer = producers[producerId]?.producer;
        console.log(producers[producerId]);

        if (!producer) {
          ws.send(JSON.stringify({ action: "consumeFailed", data: { producerId } }));
          break;
        }

        if (!router.canConsume({ producerId: producer.id, rtpCapabilities })) {
            console.log("hello");
          ws.send(JSON.stringify({ action: "consumeFailed", data: { reason: "cannot consume" } }));
          break;
        }

        const consumer = await transports[id].consumerTransport.consume({
          producerId: producer.id,
          rtpCapabilities,
        });

        if (!consumers[id]) consumers[id] = [];
        consumers[id].push(consumer);

        ws.send(
          JSON.stringify({
            action: "consumerCreated",
            data: {
              producerId: producer.id,
              id: consumer.id,
              kind: consumer.kind,
              rtpParameters: consumer.rtpParameters,
            },
          })
        );

        // Listen for consumer closure and clean up
        consumer.on("transportclose", () => consumer.close());
        break;
      }

      default:
        console.warn(`Unhandled action: ${action}`);
    }
  });

  ws.on("close", () => {
    cleanUp(id);
  });
});

// Create WebRTC transport
const createWebrtcTransport = async () => {
  return router.createWebRtcTransport(mediasoupOptions.webRtcTransport);
};

// Broadcast message to all peers except the sender
const broadcast = (sender, message) => {
  peers.forEach((peerWs, peerId) => {
    if (peerWs !== sender) {
      peerWs.send(JSON.stringify(message));
    }
  });
};

// Clean up resources for a disconnected peer
const cleanUp = (peerId) => {
  if (transports[peerId]) {
    const { producerTransport, consumerTransport } = transports[peerId];
    if (producerTransport) producerTransport.close();
    if (consumerTransport) consumerTransport.close();
    delete transports[peerId];
  }

  if (producers[peerId]) {
    const { producer } = producers[peerId];
    if (producer) producer.close();
    delete producers[peerId];
  }

  if (consumers[peerId]) {
    consumers[peerId].forEach((consumer) => consumer.close());
    delete consumers[peerId];
  }

  peers.delete(peerId);
};

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
