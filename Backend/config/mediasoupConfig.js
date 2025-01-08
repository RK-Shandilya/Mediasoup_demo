export const mediasoupOptions = {
    mediaCodecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
          'x-google-start-bitrate': 1000,
        },
      },
    ],
    webRtcTransport: {
      listenIps: [
        {
          ip: '0.0.0.0', // Replace with your server's IP
          announcedIp: '127.0.0.1', // Replace with public IP or domain
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    },
  };
  