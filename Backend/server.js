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
const peers = new Map(); // (id , socket)
const transports = new Map(); // (peerId -> { producerTransport, consumerTransport })
const producers = new Map();  // (producerId -> { producer, peerId })
const consumers = new Map();  // (consumerId -> { consumer, peerId })

const createWorker = async () => {
  worker = await mediasoup.createWorker();
  router = await worker.createRouter({ mediaCodecs: mediasoupOptions.mediaCodecs });

};

createWorker();

// Create WebRTC transport
const createWebRtcTransport = async () => {
  const transport = await router.createWebRtcTransport(mediasoupOptions.webRtcTransport);
  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    },
  };
};

// Update the notifyNewProducer function
// Notify all the peers that a new producer has been created
const notifyNewProducer = (sender, producerId, producerData) => {
    peers.forEach((peer, peerId) => {
      if (peer !== sender) {
        peer.send(JSON.stringify({
          action: "newProducer",
          data: { 
            producerId,
            peerId: producerData.peerId,
            kind: producerData.producer.kind
          }
        }));
      }
    });
  };

// Get all active producers for a new peer
const getActiveProducers = (excludePeerId) => {
    const activeProducers = [];
    producers.forEach((producerData, producerId) => {
      if (producerData.peerId !== excludePeerId) {
        activeProducers.push({
          producerId,
          peerId: producerData.peerId,
          kind: producerData.producer.kind
        });
      }
    });
    return activeProducers;
  };

wss.on("connection", (ws) => {
  const peerId = uuid();
  peers.set(peerId, ws);
  transports.set(peerId, new Map());

  // Send router RTP capabilities and active producers to the new peer
  ws.send(JSON.stringify({
    action: "routerRtpCapabilities",
    data: { 
      peerId,
      routerRtpCapabilities: router.rtpCapabilities,
      existingProducers: getActiveProducers(peerId)
    }
  }));

  ws.on("message", async (message) => {
    const { action, data } = JSON.parse(message);

    try {
      switch (action) {
        case "createProducerTransport": {
          const { transport, params } = await createWebRtcTransport();
          transports.get(peerId).set('producer', transport);
          
          ws.send(JSON.stringify({
            action: "producerTransportCreated",
            data: params
          }));
          break;
        }

        case "connectProducerTransport": {
          const transport = transports.get(peerId).get('producer');
          await transport.connect({ dtlsParameters: data.dtlsParameters });
          break;
        }

        case "produce": {
            const transport = transports.get(peerId).get('producer');
            
            const producer = await transport.produce({
              kind: data.kind,
              rtpParameters: data.rtpParameters
            });
          
            producers.set(producer.id, { producer, peerId });
            
            producer.on("transportclose", () => {
              producer.close();
              producers.delete(producer.id);
            });
          
            ws.send(JSON.stringify({
              action: "producerCreated",
              data: { id: producer.id }
            }));
          
            // Notify other peers about the new producer
            notifyNewProducer(ws, producer.id, { 
              producer, 
              peerId,
              kind: data.kind  // Make sure to include the kind
            });
            break;
          }

        case "createConsumerTransport": {
          const { transport, params } = await createWebRtcTransport();
          transports.get(peerId).set('consumer', transport);
          
          ws.send(JSON.stringify({
            action: "consumerTransportCreated",
            data: {
              ...params
            }
          }));
          break;
        }

        case "connectConsumerTransport": {
          const transport = transports.get(peerId).get('consumer');
          await transport.connect({ dtlsParameters: data.dtlsParameters });
          break;
        }

        case "consume": {
          const { producerId, rtpCapabilities } = data;
          const producerData = producers.get(producerId);
          
          if (!producerData) {
            ws.send(JSON.stringify({
              action: "consumeFailed",
              data: { reason: "Producer not found" }
            }));
            break;
          }

          if (!router.canConsume({ producerId, rtpCapabilities })) {
            ws.send(JSON.stringify({
              action: "consumeFailed",
              data: { reason: "Cannot consume producer" }
            }));
            break;
          }

          const transport = transports.get(peerId).get('consumer');
          
          if (!transport) {
            ws.send(JSON.stringify({
              action: "consumeFailed",
              data: { reason: "Consumer transport not found" }
            }));
            break;
          }

          const consumer = await transport.consume({
            producerId,
            rtpCapabilities,
          });

          consumers.set(consumer.id, { consumer, peerId });

          consumer.on("producerclose", () => {
            consumer.close();
            consumers.delete(consumer.id);
            ws.send(JSON.stringify({
              action: "producerClosed",
              data: { producerId }
            }));
          });

          ws.send(JSON.stringify({
            action: "consumerCreated",
            data: {
              producerId: producerId,
              id: consumer.id,
              kind: consumer.kind,
              rtpParameters: consumer.rtpParameters,
              producerPeerId: producerData.peerId
            }
          }));
          
          break;
        }

        case "resumeConsumer": {
          const { consumerId } = data;
          const consumerData = consumers.get(consumerId);
          if (consumerData) {
            await consumerData.consumer.resume();
          }
          break;
        }
      }
    } catch (error) {
      console.error('Error handling message:', error);
      ws.send(JSON.stringify({
        action: "error",
        data: { message: error.message }
      }));
    }
  });

  ws.on("close", () => {
    
    // Close all transports
    const peerTransports = transports.get(peerId);
    if (peerTransports) {
      peerTransports.forEach(transport => transport.close());
      transports.delete(peerId);
    }

    // Close all producers
    producers.forEach((producerData, producerId) => {
      if (producerData.peerId === peerId) {
        producerData.producer.close();
        producers.delete(producerId);
      }
    });

    // Close all consumers
    consumers.forEach((consumerData, consumerId) => {
      if (consumerData.peerId === peerId) {
        consumerData.consumer.close();
        consumers.delete(consumerId);
      }
    });

    // Remove peer
    peers.delete(peerId);

    // Notify other peers about disconnection
    peers.forEach(peer => {
      peer.send(JSON.stringify({
        action: "peerDisconnected",
        data: { peerId }
      }));
    });
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
