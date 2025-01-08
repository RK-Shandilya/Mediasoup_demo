import React, { useState, useEffect, useRef } from "react";
import { Device } from "mediasoup-client";
import { Producer } from "mediasoup-client/lib/types";

const App = () => {
  const [peerId, setPeerId] = useState(null);
  const socketRef = useRef(null);
  const deviceRef = useRef(null);
  const [remoteStreams, setRemoteStreams] = useState({});

  const localVideoRef = useRef(null);
  const remoteVideoRefs = useRef({});

  useEffect(() => {
    const socket = new WebSocket("ws://localhost:3001");
    socketRef.current = socket;

    socket.onmessage = async (event) => {
      const { action, data } = JSON.parse(event.data);
      await handleServerMessage(action, data);
    };

    return () => socket.close();
  }, []);

  const handleServerMessage = async (action, data) => {
    const socket = socketRef.current;

    switch (action) {
      case "routerRtpCapabilities": {
        setPeerId(data.peerId);
        const device = new Device();
        await device.load({ routerRtpCapabilities: data.routerRtpCapabilities });
        deviceRef.current = device;
        socket.send(JSON.stringify({ action: "createProducerTransport" }));
        break;
      }

      case "producerTransportCreated": {
        const transport = await createTransport(data, "Producer");
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideoRef.current.srcObject = stream;

        const videoTrack = stream.getVideoTracks()[0];
        const audioTrack = stream.getAudioTracks()[0];

        if (videoTrack) {
          await transport.produce({ track: videoTrack });
        }
        if (audioTrack) {
          await transport.produce({ track: audioTrack });
        }
        break;
      }

      case "newProducer": {
        socket.send(JSON.stringify({ action: "createConsumerTransport", data: { producerId: data.producerId } }));
        break;
      }

      case "consumerTransportCreated": {
        const transport = await createTransport(data, "Consumer");
        console.log(data.producerId)
        socket.send(
          JSON.stringify({
            action: "consume",
            data: { producerId: data.producerId, rtpCapabilities: deviceRef.current.rtpCapabilities },
          })
        );
        break;
      }

      case "consumeFailed": {
        console.error(`Consume request failed: ${data.reason}`);
        break;
      }

      case "consumerCreated": {
        const { producerId, id, kind, rtpParameters } = data;

        const consumer = await transports.consumerTransport.consume({
          id,
          producerId,
          kind,
          rtpParameters,
        });

        const consumerStream = new MediaStream();
        consumerStream.addTrack(consumer.track);

        setRemoteStreams((prev) => ({ ...prev, [producerId]: consumerStream }));

        // Handle consumer closure
        consumer.on("transportclose", () => consumer.close());
        consumer.on("producerclose", () => {
          consumer.close();
          setRemoteStreams((prev) => {
            const updated = { ...prev };
            delete updated[producerId];
            return updated;
          });
        });

        break;
      }

      default:
        console.warn(`Unhandled action: ${action}`);
    }
  };

  const createTransport = async (data, type) => {
    const { id, iceParameters, iceCandidates, dtlsParameters } = data;
    const device = deviceRef.current;
    const transport =
      type === "Producer"
        ? device.createSendTransport({ id, iceParameters, iceCandidates, dtlsParameters })
        : device.createRecvTransport({ id, iceParameters, iceCandidates, dtlsParameters });

    transport.on("connect", ({ dtlsParameters }, callback, errback) => {
      socketRef.current.send(JSON.stringify({ action: `connect${type}Transport`, data: { dtlsParameters } }));
      callback();
    });

    if (type === "Producer") {
      transport.on("produce", ({ kind, rtpParameters }, callback, errback) => {
        socketRef.current.send(JSON.stringify({ action: "produce", data: { kind, rtpParameters } }));
        socketRef.current.onmessage = (event) => {
          const { action, data } = JSON.parse(event.data);
          if (action === "producerCreated") {
            callback({ id: data.id });
          }
        };
      });
    } 

    return transport;
  };

  useEffect(() => {
    Object.entries(remoteStreams).forEach(([producerId, stream]) => {
      if (remoteVideoRefs.current[producerId]) {
        remoteVideoRefs.current[producerId].srcObject = stream;
      }
    });
  }, [remoteStreams]);

  return (
    <div>
      <video ref={localVideoRef} autoPlay muted />
      {Object.entries(remoteStreams).map(([producerId, stream]) => (
        <video key={producerId} ref={(el) => (remoteVideoRefs.current[producerId] = el)} autoPlay />
      ))}
    </div>
  );
};

export default App;
