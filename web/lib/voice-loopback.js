const ua = navigator.userAgent;
export const appleAudio = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) || (/Safari\//.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua));

/** 本页里一对 RTCPeerConnection 把声音环回一下，让浏览器的回声消除认得它（见 appleAudio） */
export async function loopback(stream) {
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  const close = () => {
    a.close();
    b.close();
  };
  try {
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
    const got = new Promise((resolve, reject) => {
      b.ontrack = (e) => resolve(e.streams[0] ?? new MediaStream([e.track]));
      setTimeout(() => reject(new Error("环回超时")), 3000);
    });
    for (const t of stream.getTracks()) a.addTrack(t, stream);
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
    return { stream: await got, close };
  } catch (err) {
    close();
    throw err;
  }
}
