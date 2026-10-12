// Tiny worker used for the delay between bulk emails.
// Chrome slows down timers in background tabs; timers inside a worker are not slowed.
self.onmessage = (event) => {
  const { id, ms } = event.data;
  setTimeout(() => self.postMessage({ id }), ms);
};
