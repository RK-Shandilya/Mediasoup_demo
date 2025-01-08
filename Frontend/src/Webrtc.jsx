import React, { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';

const WebRTCClient = () => {
  const [isConnected, setIsConnected] = useState(false);
  const [isProducing, setIsProducing] = useState(false);
  const [isConsuming, setIsConsuming] = useState(false);
  const [error, setError] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  
  const wsRef = useRef(null);
  const streamRef = useRef(null);
  const videoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const producerTransportRef = useRef<RTCPeerConnection | null>(null);
  const consumerTransportRef = useRef(null);
  const deviceRef = useRef(null);
  const producerRef = useRef(null);
  const consumerRef = useRef(null);

  // Function to safely parse JSON
  const safeJSONParse = (data) => {
    try {
      return JSON.parse(data);
    } catch (err) {
      console.error('JSON Parse error:', err);
      return null;
    }
  };

  // Function to safely send WebSocket messages
  const safeSendMessage = (message) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify(message));
      } catch (err) {
        setError(`Failed to send message: ${err.message}`);
      }
    } else {
      setError('WebSocket is not connected');
    }
  };

  useEffect(() => {
    connectWebSocket();
    return () => {
      cleanupResources();
    };
  }, []);

  const cleanupResources = () => {
    // Stop all tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    
    // Close peer connections
    if (producerTransportRef.current) {
      producerTransportRef.current.close();
    }
    if (consumerTransportRef.current) {
      consumerTransportRef.current.close();
    }
    
    // Close WebSocket
    if (wsRef.current) {
      wsRef.current.close();
    }
  };

  const connectWebSocket = () => {
    try {
      // Use secure WebSocket if on HTTPS, otherwise fallback to regular WebSocket
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.hostname;
      const port = '3001'; // Your server port
      const wsUrl = `${protocol}//${host}:${port}`;

      wsRef.current = new WebSocket(wsUrl);
      setConnectionStatus('connecting');
      
      wsRef.current.onopen = () => {
        setIsConnected(true);
        setConnectionStatus('connected');
        setError('');
      };

      wsRef.current.onmessage = async (event) => {
        const message = safeJSONParse(event.data);
        if (!message) return;
        
        try {
          if (message.action === 'routerRtpCapabilities') {
            // Initialize RTCPeerConnection with STUN servers
            deviceRef.current = new RTCPeerConnection({
              iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
              ],
              iceCandidatePoolSize: 10
            });
            
            deviceRef.current.oniceconnectionstatechange = () => {
              setConnectionStatus(deviceRef.current.iceConnectionState);
            };
            
            await createProducerTransport();
          }
        } catch (err) {
          setError(`Failed to process message: ${err.message}`);
        }
      };

      wsRef.current.onerror = (error) => {
        setError(`WebSocket error: ${error.message}`);
        setIsConnected(false);
        setConnectionStatus('error');
      };

      wsRef.current.onclose = () => {
        setIsConnected(false);
        setConnectionStatus('disconnected');
        // Attempt to reconnect after a delay
        setTimeout(connectWebSocket, 5000);
      };
    } catch (err) {
      setError(`Failed to create WebSocket connection: ${err.message}`);
      setConnectionStatus('error');
    }
  };

  const createProducerTransport = async () => {
    try {
      safeSendMessage({
        type: 'createWebrtcTransport',
        data: { sender: true }
      });

      wsRef.current.onmessage = async (event) => {
        const message = safeJSONParse(event.data);
        if (!message?.params) return;
        
        try {
          if (message.params.error) {
            throw new Error(message.params.error);
          }

          producerTransportRef.current = deviceRef.current;
          
          // Set up ICE candidates
          message.params.iceCandidates.forEach(candidate => {
            producerTransportRef.current?.addIceCandidate(new RTCIceCandidate(candidate))
              .catch(err => console.error('Error adding ICE candidate:', err));
          });

          // Set remote description
          await producerTransportRef.current.setRemoteDescription(
            new RTCSessionDescription(message.params.dtlsParameters)
          );

          // Create and set local description
          const offer = await producerTransportRef.current.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
          });
          await producerTransportRef.current.setLocalDescription(offer);

          safeSendMessage({
            type: 'transport-connect',
            data: { 
              dtlsParameters: producerTransportRef.current.localDescription 
            }
          });
        } catch (err) {
          setError(`Transport creation failed: ${err.message}`);
        }
      };
    } catch (err) {
      setError(`Failed to create producer transport: ${err.message}`);
    }
  };

  const startStreaming = async () => {
    try {
      const constraints = {
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        },
        audio: true
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      // Add tracks to peer connection
      stream.getTracks().forEach(track => {
        producerRef.current = deviceRef.current.addTrack(track, stream);
        
        // Handle track ended event
        track.onended = () => {
          stopStreaming();
        };
      });

      setIsProducing(true);
      setError('');

      safeSendMessage({
        type: 'transport-produce',
        data: {
          kind: 'video',
          rtpParameters: producerRef.current.getParameters()
        }
      });
    } catch (err) {
      setError(`Failed to start streaming: ${err.message}`);
      stopStreaming();
    }
  };

  const stopStreaming = () => {
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      setIsProducing(false);
    } catch (err) {
      setError(`Failed to stop streaming: ${err.message}`);
    }
  };

  return (
    <Card className="w-full max-w-4xl mx-auto">
      <CardHeader>
        <CardTitle>WebRTC Video Stream</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <Button
              onClick={startStreaming}
              disabled={!isConnected || isProducing}
              className="bg-green-500 hover:bg-green-600 disabled:bg-gray-300"
            >
              Start Streaming
            </Button>
            <Button
              onClick={stopStreaming}
              disabled={!isProducing}
              className="bg-red-500 hover:bg-red-600 disabled:bg-gray-300"
            >
              Stop Streaming
            </Button>
            <div className="text-sm">
              Status: {connectionStatus}
            </div>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <h3 className="text-lg font-semibold mb-2">Local Stream</h3>
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full aspect-video bg-black rounded"
              />
            </div>
            <div>
              <h3 className="text-lg font-semibold mb-2">Remote Stream</h3>
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                className="w-full aspect-video bg-black rounded"
              />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default WebRTCClient;