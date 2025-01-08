export async function createPeerConnection(iceServers = []) {
    const pc = new RTCPeerConnection({ iceServers });
  
    // Handle ICE candidate events
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        // Send the ICE candidate to the server
        // This should be implemented in your main component
      }
    };
  
    return pc;
  }
  
  export async function createOffer(peerConnection) {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    return offer;
  }
  
  export async function createAnswer(peerConnection, offer) {
    await peerConnection.setRemoteDescription(offer);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    return answer;
  }
  
  export function addTrackToPeerConnection(peerConnection, track, stream) {
    peerConnection.addTrack(track, stream);
  }
  
  