import React, { useState, useEffect, useRef } from "react";
import { Device } from "mediasoup-client";

const App = () => {
  const [peerId, setPeerId] = useState(null);
  const socketRef = useRef(null);
  const deviceRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRefs = useRef({});
  const producerTransportRef = useRef(null);
  const consumerTransportRef = useRef(null);
  const pendingConsumes = useRef(new Map());
  const consumersRef = useRef(new Map()); // Track active consumers
  
  const [remoteStreams, setRemoteStreams] = useState({});

  useEffect(() => {
    const socket = new WebSocket("ws://localhost:3001");
    socketRef.current = socket;

    socket.onmessage = async (event) => {
      const { action, data } = JSON.parse(event.data);
      console.log("Received action:", action, data);
      await handleServerMessage(action, data);
    };

    socket.onopen = () => {
      console.log("WebSocket connected");
    };

    return () => socket.close();
  }, []);

  const ensureRemoteStream = (peerId) => {
    setRemoteStreams(prev => {
      if (!prev[peerId]) {
        console.log("Creating new MediaStream for peer:", peerId);
        return {
          ...prev,
          [peerId]: new MediaStream()
        };
      }
      return prev;
    });
  };


  const handleServerMessage = async (action, data) => {
    const socket = socketRef.current;

    switch (action) {
      case "routerRtpCapabilities": {
        setPeerId(data.peerId);
        const device = new Device();
        await device.load({ routerRtpCapabilities: data.routerRtpCapabilities });
        deviceRef.current = device;
        
        // Handle existing producers before creating producer transport
        if (data.existingProducers && data.existingProducers.length > 0) {
          console.log("Handling existing producers:", data.existingProducers);
          // Create consumer transport first to handle existing producers
          socket.send(JSON.stringify({ action: "createConsumerTransport" }));
          
          // Store the producers to consume after transport is created
          data.existingProducers.forEach(({producerId, peerId, kind}) => {
            console.log("Storing existing producer for consumption:", producerId, peerId, kind);
            pendingConsumes.current.set(producerId, { peerId, kind });
          });
        } else {
          // If no existing producers, proceed with creating producer transport
          socket.send(JSON.stringify({ action: "createProducerTransport" }));
        }
        break;
      }

      case "producerTransportCreated": {
        try {
          const transport = await createTransport(data, "Producer");
          producerTransportRef.current = transport;
          
          const stream = await navigator.mediaDevices.getUserMedia({ 
            video: true, 
            audio: true 
          });
          localVideoRef.current.srcObject = stream;

          // Produce video first
          const videoTrack = stream.getVideoTracks()[0];
          if (videoTrack) {
            console.log("Producing video track");
            await transport.produce({ 
              track: videoTrack,
              kind: 'video',
              encodings: [
                { maxBitrate: 100000, scaleResolutionDownBy: 4 },
                { maxBitrate: 300000, scaleResolutionDownBy: 2 },
                { maxBitrate: 900000, scaleResolutionDownBy: 1 }
              ]
            });
          }

          // Then produce audio
          const audioTrack = stream.getAudioTracks()[0];
          if (audioTrack) {
            console.log("Producing audio track");
            await transport.produce({ 
              track: audioTrack,
              kind: 'audio'
            });
          }
        } catch (error) {
          console.error("Error in producerTransportCreated:", error);
        }
      }

      case "newProducer": {
        const { producerId, peerId, kind } = data;
        console.log("New producer received:", producerId, peerId, kind);

        if (!consumerTransportRef.current) {
          pendingConsumes.current.set(producerId, { peerId, kind });
          socket.send(JSON.stringify({ 
            action: "createConsumerTransport",
            data: { producerId, peerId, kind }
          }));
        } else {
          // Request consumption immediately
          socket.send(JSON.stringify({
            action: "consume",
            data: {
              producerId,
              rtpCapabilities: deviceRef.current.rtpCapabilities
            }
          }));
        }
        break;
      }

      case "consumerTransportCreated": {
        try {
          const transport = await createTransport(data, "Consumer");
          consumerTransportRef.current = transport;

          // Consume all pending producers
          for (const [producerId, info] of pendingConsumes.current) {
            console.log("Consuming pending producer:", producerId, info);
            socket.send(JSON.stringify({
              action: "consume",
              data: {
                producerId,
                rtpCapabilities: deviceRef.current.rtpCapabilities
              }
            }));
          }

          // If this was created for handling existing producers, now create producer transport
          if (!producerTransportRef.current) {
            socket.send(JSON.stringify({ action: "createProducerTransport" }));
          }
        } catch (error) {
          console.error("Error in consumerTransportCreated:", error);
        }
        break;
      }

      case "consumerCreated": {
        try {
          const { producerId, id, kind, rtpParameters, producerPeerId } = data;
          console.log("Creating consumer:", producerId, kind, producerPeerId);
          
          const transport = consumerTransportRef.current;
          if (!transport) {
            throw new Error("Consumer transport not found");
          }

          const consumer = await transport.consume({
            id,
            producerId,
            kind,
            rtpParameters,
          });

          // Store the consumer
          if (!consumersRef.current.has(producerPeerId)) {
            consumersRef.current.set(producerPeerId, new Map());
          }
          consumersRef.current.get(producerPeerId).set(kind, consumer);

          // Only create the MediaStream when we actually have a consumer
          setRemoteStreams(prev => {
            let stream = prev[producerPeerId];
            if (!stream) {
              stream = new MediaStream();
              prev = { ...prev, [producerPeerId]: stream };
            }
            
            // Remove any existing tracks of the same kind
            const existingTracks = kind === 'video' 
              ? stream.getVideoTracks() 
              : stream.getAudioTracks();
            
            existingTracks.forEach(track => stream.removeTrack(track));
            
            // Add the new track
            stream.addTrack(consumer.track);
            
            console.log(`Added ${kind} track to stream:`, {
              peerId: producerPeerId,
              trackId: consumer.track.id,
              enabled: consumer.track.enabled,
              muted: consumer.track.muted,
              videoTracks: stream.getVideoTracks().length,
              audioTracks: stream.getAudioTracks().length
            });

            return prev;
          });

          // Resume the consumer
          await consumer.resume();

          consumer.on("transportclose", () => {
            consumer.close();
            removeConsumer(producerPeerId, kind);
          });

          consumer.on("producerclose", () => {
            consumer.close();
            removeConsumer(producerPeerId, kind);
          });

        } catch (error) {
          console.error("Error in consuming:", error);
        }
        break;
      }

      case "producerClosed": {
        const { producerId, peerId, kind } = data;
        removeConsumer(peerId, kind);
        break;
      }
    }
  };

  const removeConsumer = (peerId, kind) => {
    const peerConsumers = consumersRef.current.get(peerId);
    if (peerConsumers) {
      const consumer = peerConsumers.get(kind);
      if (consumer) {
        consumer.close();
        peerConsumers.delete(kind);
      }
      if (peerConsumers.size === 0) {
        consumersRef.current.delete(peerId);
      }
    }

    setRemoteStreams(prev => {
      const stream = prev[peerId];
      if (stream) {
        const tracks = kind === 'video' ? stream.getVideoTracks() : stream.getAudioTracks();
        tracks.forEach(track => {
          track.stop();
          stream.removeTrack(track);
        });

        // Only keep peers that have tracks
        if (stream.getTracks().length === 0) {
          const updated = { ...prev };
          delete updated[peerId];
          return updated;
        }
      }
      return prev;
    });
  };
  
  const createTransport = async (data, type) => {
    const { id, iceParameters, iceCandidates, dtlsParameters } = data;
    const device = deviceRef.current;
  
    try {
      const transport = type === "Producer"
        ? await device.createSendTransport({
            id,
            iceParameters,
            iceCandidates,
            dtlsParameters,
          })
        : await device.createRecvTransport({
            id,
            iceParameters,
            iceCandidates,
            dtlsParameters,
          });
  
      transport.on("connect", async ({ dtlsParameters }, callback, errback) => {
        try {
          await new Promise((resolve) => {
            socketRef.current.send(JSON.stringify({
              action: `connect${type}Transport`,
              data: { dtlsParameters }
            }));
            resolve();
          });
          callback();
        } catch (error) {
          errback(error);
        }
      });
  
      if (type === "Producer") {
        transport.on("produce", ({ kind, rtpParameters }, callback, errback) => {
          socketRef.current.send(JSON.stringify({
            action: "produce",
            data: { kind, rtpParameters }
          }));
          
          const handleProducerCreated = (event) => {
            const { action, data } = JSON.parse(event.data);
            if (action === "producerCreated") {
              callback({ id: data.id });
              socketRef.current.removeEventListener("message", handleProducerCreated);
            }
          };
          
          socketRef.current.addEventListener("message", handleProducerCreated);
        });
      }
  
      return transport;
    } catch (error) {
      console.error(`Error creating ${type} transport:`, error);
      throw error;
    }
  };
  
  useEffect(() => {
    Object.entries(remoteStreams).forEach(([peerId, stream]) => {
      if (remoteVideoRefs.current[peerId]) {
        remoteVideoRefs.current[peerId].srcObject = stream;
      }
    });
  }, [remoteStreams]);

  return (
    <div className="p-4">
      <div className="mb-4">
        <h2 className="text-xl mb-2">Local Video</h2>
        <video 
          ref={localVideoRef} 
          autoPlay 
          muted 
          playsInline
          className="w-64 h-48 bg-black"
        />
      </div>
      <div>
        <h2 className="text-xl mb-2">Remote Videos ({Object.keys(remoteStreams).length})</h2>
        <div className="grid grid-cols-2 gap-4">
          {Object.entries(remoteStreams).map(([peerId, stream]) => {
            // Only render if there are actual tracks
            if (stream.getTracks().length === 0) return null;
            
            return (
              <div key={peerId} className="relative">
                <video
                  ref={el => (remoteVideoRefs.current[peerId] = el)}
                  autoPlay
                  playsInline
                  className="w-64 h-48 bg-black"
                />
                <div className="absolute top-0 left-0 p-1 bg-black bg-opacity-50 text-white text-sm">
                  Tracks: V({stream.getVideoTracks().length}) A({stream.getAudioTracks().length})
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default App;